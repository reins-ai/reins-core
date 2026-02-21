import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Database } from "bun:sqlite";

import { createLogger } from "../../logger";
import { ReinsError } from "../../errors";

const log = createLogger("memory:sqlite-db");
import { err, ok, type Result } from "../../result";

const MIGRATION_FILE_PATTERN = /^(\d+)_.*\.sql$/;

interface MigrationDefinition {
  version: number;
  name: string;
  sql: string;
}

interface SchemaVersionRow {
  version: number;
}

export interface SqliteMemoryDbOptions {
  dbPath: string;
}

export class MemoryDbError extends ReinsError {
  constructor(message: string, code = "MEMORY_DB_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "MemoryDbError";
  }
}

function isInMemoryPath(dbPath: string): boolean {
  return dbPath === ":memory:" || dbPath.startsWith("file::memory:");
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

export class SqliteMemoryDb {
  private readonly dbPath: string;
  private db: Database | null = null;

  constructor(options: SqliteMemoryDbOptions) {
    this.dbPath = options.dbPath;
  }

  initialize(): Result<void, MemoryDbError> {
    if (this.db !== null) {
      return ok(undefined);
    }

    try {
      if (!isInMemoryPath(this.dbPath)) {
        mkdirSync(dirname(this.dbPath), { recursive: true });
      }

      const db = new Database(this.dbPath, { create: true });

      db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA foreign_keys=ON");

      this.ensureSchemaVersionTable(db);

      const migrationsResult = this.loadMigrations();
      if (!migrationsResult.ok) {
        db.close();
        return migrationsResult;
      }

      const applyResult = this.applyMigrations(db, migrationsResult.value);
      if (!applyResult.ok) {
        db.close();
        return applyResult;
      }

      this.db = db;
      return ok(undefined);
    } catch (cause) {
      return err(new MemoryDbError("Failed to initialize SQLite memory database", "MEMORY_DB_INIT_FAILED", asError(cause)));
    }
  }

  getDb(): Database {
    if (this.db === null) {
      throw new MemoryDbError("Memory database has not been initialized", "MEMORY_DB_NOT_INITIALIZED");
    }

    return this.db;
  }

  close(): void {
    if (this.db !== null) {
      this.db.close();
      this.db = null;
    }
  }

  private ensureSchemaVersionTable(db: Database): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private loadMigrations(): Result<MigrationDefinition[], MemoryDbError> {
    try {
      const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "migrations");
      const migrationNames = readdirSync(migrationsDirectory)
        .filter((entry) => extname(entry) === ".sql")
        .sort((left, right) => left.localeCompare(right));

      const migrations: MigrationDefinition[] = [];

      for (const migrationName of migrationNames) {
        const match = MIGRATION_FILE_PATTERN.exec(migrationName);
        if (!match) {
          continue;
        }

        const version = Number.parseInt(match[1] ?? "", 10);
        if (!Number.isFinite(version)) {
          return err(
            new MemoryDbError(
              `Invalid migration filename: ${migrationName}`,
              "MEMORY_DB_INVALID_MIGRATION_FILENAME",
            ),
          );
        }

        const sql = readFileSync(join(migrationsDirectory, migrationName), "utf8");
        migrations.push({ version, name: migrationName, sql });
      }

      return ok(migrations.sort((left, right) => left.version - right.version));
    } catch (cause) {
      return err(new MemoryDbError("Failed to load SQLite migration files", "MEMORY_DB_MIGRATION_LOAD_FAILED", asError(cause)));
    }
  }

  private applyMigrations(
    db: Database,
    migrations: MigrationDefinition[],
  ): Result<void, MemoryDbError> {
    const appliedRows = db
      .query("SELECT version FROM schema_version ORDER BY version ASC")
      .all() as SchemaVersionRow[];
    const appliedVersions = new Set(appliedRows.map((row) => row.version));

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec(migration.sql);
        db.query("INSERT INTO schema_version(version, name) VALUES (?1, ?2)").run(
          migration.version,
          migration.name,
        );
        db.exec("COMMIT");
      } catch (cause) {
        this.safeRollback(db);
        return err(
          new MemoryDbError(
            `Failed to apply migration ${migration.name}`,
            "MEMORY_DB_MIGRATION_APPLY_FAILED",
            asError(cause),
          ),
        );
      }
    }

    return ok(undefined);
  }

  private safeRollback(db: Database): void {
    try {
      db.exec("ROLLBACK");
    } catch (e) {
      // Expected: ROLLBACK may fail if no transaction is active
      log.debug("rollback failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
