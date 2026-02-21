import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createLogger } from "../../logger";
import { parse, serialize, type MemoryFileRecord } from "../io/index";

const log = createLogger("memory:repository");
import {
  isValidMemorySourceType,
  isValidPersistedMemoryLayer,
  validateMemoryRecord,
  type MemoryLayer,
  type MemoryRecord,
  type MemorySourceType,
  type MemoryType,
  type PersistedMemoryLayer,
} from "../types/index";
import { err, ok, type Result } from "../../result";
import { SqliteMemoryDb } from "./sqlite-memory-db";
import { MemoryRepositoryError } from "./memory-repository-errors";

interface MemoryRow {
  id: string;
  content: string;
  type: string;
  layer: string;
  importance: number;
  confidence: number;
  tags: string | null;
  entities: string | null;
  source_type: string;
  source_conversation_id: string | null;
  source_message_id: string | null;
  supersedes_id: string | null;
  superseded_by_id: string | null;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

interface CountRow {
  count: number;
}

interface ReconciliationRow {
  id: string;
  content: string;
}

interface ProvenanceDetails {
  checksum: string;
  fileName: string;
  sourceMessageId?: string;
}

interface MemoryFileProjection {
  fileName: string;
  content: string;
}

export interface CreateMemoryInput {
  content: string;
  type: MemoryType;
  layer?: MemoryLayer;
  importance?: number;
  confidence?: number;
  tags?: string[];
  entities?: string[];
  source: {
    type: MemorySourceType;
    conversationId?: string;
    messageId?: string;
  };
  supersedes?: string;
}

export interface UpdateMemoryInput {
  content?: string;
  importance?: number;
  confidence?: number;
  tags?: string[];
  entities?: string[];
  supersedes?: string | null;
  supersededBy?: string | null;
}

export interface ListMemoryOptions {
  limit?: number;
  offset?: number;
  type?: MemoryType;
  layer?: PersistedMemoryLayer;
  sourceType?: MemorySourceType;
}

export interface ReconciliationReport {
  totalFiles: number;
  totalDbRecords: number;
  orphanedFiles: string[];
  missingFiles: string[];
  contentMismatches: string[];
  isConsistent: boolean;
}

export interface MemoryRepository {
  create(input: CreateMemoryInput): Promise<Result<MemoryRecord>>;
  getById(id: string): Promise<Result<MemoryRecord | null>>;
  update(id: string, input: UpdateMemoryInput): Promise<Result<MemoryRecord>>;
  delete(id: string): Promise<Result<void>>;
  list(options?: ListMemoryOptions): Promise<Result<MemoryRecord[]>>;
  findByType(type: MemoryType): Promise<Result<MemoryRecord[]>>;
  findByLayer(layer: MemoryLayer): Promise<Result<MemoryRecord[]>>;
  count(): Promise<Result<number>>;
  reconcile(): Promise<Result<ReconciliationReport>>;
}

export interface MemoryRepositoryOptions {
  db: SqliteMemoryDb;
  dataDir: string;
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

function toIsoWithoutMs(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "");
}

function toFileTimestamp(date: Date): string {
  return toIsoWithoutMs(date).replace(/:/g, "-");
}

function shortId(id: string): string {
  const compact = id.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  return compact.slice(0, 7) || "MEMORY";
}

function buildFileName(record: MemoryRecord): string {
  return `${toFileTimestamp(record.createdAt)}_${record.type}_${shortId(record.id)}.md`;
}

function toDate(value: string | null, fallback: string): Date {
  const candidate = value ?? fallback;
  const normalized = candidate.includes("T") ? candidate : candidate.replace(" ", "T") + "Z";
  return new Date(normalized);
}

function parseStringArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function checksumOf(markdown: string): string {
  return createHash("sha256").update(markdown, "utf8").digest("hex");
}

function normalizeTextList(values?: string[]): string[] {
  if (!values) {
    return [];
  }

  return Array.from(
    new Set(
      values
        .map((value) => value.trim())
        .filter((value) => value.length > 0),
    ),
  );
}

function toPersistedLayer(layer: MemoryLayer | undefined): Result<PersistedMemoryLayer, MemoryRepositoryError> {
  if (!layer || layer === "stm") {
    return ok("stm");
  }

  if (layer === "ltm") {
    return ok("ltm");
  }

  return err(
    new MemoryRepositoryError(
      "Only persisted layers ('stm' and 'ltm') can be stored in repository",
      "MEMORY_REPOSITORY_INVALID_INPUT",
    ),
  );
}

function isScore(value: number | undefined): boolean {
  if (typeof value !== "number") {
    return false;
  }

  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export class SqliteMemoryRepository implements MemoryRepository {
  private readonly db: SqliteMemoryDb;
  private readonly dataDir: string;

  constructor(options: MemoryRepositoryOptions) {
    this.db = options.db;
    this.dataDir = options.dataDir;
  }

  async create(input: CreateMemoryInput): Promise<Result<MemoryRecord>> {
    if (!input.content.trim()) {
      return err(new MemoryRepositoryError("Memory content is required", "MEMORY_REPOSITORY_INVALID_INPUT"));
    }

    if (!isValidMemorySourceType(input.source.type)) {
      return err(
        new MemoryRepositoryError("Memory source.type is invalid", "MEMORY_REPOSITORY_INVALID_INPUT"),
      );
    }

    const layerResult = toPersistedLayer(input.layer);
    if (!layerResult.ok) {
      return layerResult;
    }

    const importance = input.importance ?? 0.5;
    const confidence = input.confidence ?? 1.0;

    if (!isScore(importance) || !isScore(confidence)) {
      return err(
        new MemoryRepositoryError(
          "importance and confidence must be numbers between 0 and 1",
          "MEMORY_REPOSITORY_INVALID_INPUT",
        ),
      );
    }

    const now = new Date();
    const record: MemoryRecord = {
      id: randomUUID(),
      content: input.content,
      type: input.type,
      layer: layerResult.value,
      tags: normalizeTextList(input.tags),
      entities: normalizeTextList(input.entities),
      importance,
      confidence,
      provenance: {
        sourceType: input.source.type,
        conversationId: input.source.conversationId,
      },
      supersedes: input.supersedes,
      createdAt: now,
      updatedAt: now,
      accessedAt: now,
    };

    const validated = validateMemoryRecord(record);
    if (!validated.ok) {
      return err(
        new MemoryRepositoryError(
          `Memory record validation failed: ${validated.error.message}`,
          "MEMORY_REPOSITORY_INVALID_INPUT",
          validated.error,
        ),
      );
    }

    const fileName = buildFileName(record);
    const filePath = join(this.dataDir, fileName);
    const tempPath = `${filePath}.tmp-${randomUUID()}`;
    const markdown = this.serializeRecord(record, input.source.messageId);
    if (!markdown.ok) {
      return markdown;
    }

    const checksum = checksumOf(markdown.value);
    const provenance: ProvenanceDetails = {
      checksum,
      fileName,
      sourceMessageId: input.source.messageId,
    };

    try {
      await mkdir(this.dataDir, { recursive: true });
      const db = this.db.getDb();
      db.exec("BEGIN IMMEDIATE");

      try {
        this.insertMemory(db, record, input.source.messageId);
        this.insertProvenance(db, record.id, "created", provenance);
        await writeFile(tempPath, markdown.value, "utf8");
        await rename(tempPath, filePath);
        db.exec("COMMIT");
      } catch (cause) {
        this.rollback(db);
        await this.safeUnlink(tempPath);
        return err(
          new MemoryRepositoryError(
            "Failed to create memory with dual-write persistence",
            "MEMORY_REPOSITORY_IO_ERROR",
            asError(cause),
          ),
        );
      }

      return ok(record);
    } catch (cause) {
      return err(
        new MemoryRepositoryError(
          "Failed to initialize memory persistence write path",
          "MEMORY_REPOSITORY_DB_ERROR",
          asError(cause),
        ),
      );
    }
  }

  async getById(id: string): Promise<Result<MemoryRecord | null>> {
    try {
      const db = this.db.getDb();
      const row = db
        .query(
          `
            SELECT
              id,
              content,
              type,
              layer,
              importance,
              confidence,
              tags,
              entities,
              source_type,
              source_conversation_id,
              source_message_id,
              supersedes_id,
              superseded_by_id,
              created_at,
              updated_at,
              last_accessed_at
            FROM memories
            WHERE id = ?1
            LIMIT 1
          `,
        )
        .get(id) as MemoryRow | null;

      if (!row) {
        return ok(null);
      }

      const mapped = this.mapRowToRecord(row);
      if (!mapped.ok) {
        return mapped;
      }

      return ok(mapped.value);
    } catch (cause) {
      return err(
        new MemoryRepositoryError(
          "Failed to load memory by id",
          "MEMORY_REPOSITORY_DB_ERROR",
          asError(cause),
        ),
      );
    }
  }

  async update(id: string, input: UpdateMemoryInput): Promise<Result<MemoryRecord>> {
    const current = await this.getById(id);
    if (!current.ok) {
      return current;
    }

    if (!current.value) {
      return err(new MemoryRepositoryError(`Memory '${id}' not found`, "MEMORY_REPOSITORY_NOT_FOUND"));
    }

    if (
      (typeof input.importance !== "undefined" && !isScore(input.importance)) ||
      (typeof input.confidence !== "undefined" && !isScore(input.confidence))
    ) {
      return err(
        new MemoryRepositoryError(
          "importance and confidence must be numbers between 0 and 1",
          "MEMORY_REPOSITORY_INVALID_INPUT",
        ),
      );
    }

    const updatedAt = new Date();
    const nextRecord: MemoryRecord = {
      ...current.value,
      content: input.content ?? current.value.content,
      importance: input.importance ?? current.value.importance,
      confidence: input.confidence ?? current.value.confidence,
      tags: input.tags ? normalizeTextList(input.tags) : current.value.tags,
      entities: input.entities ? normalizeTextList(input.entities) : current.value.entities,
      supersedes:
        typeof input.supersedes === "undefined"
          ? current.value.supersedes
          : input.supersedes ?? undefined,
      supersededBy:
        typeof input.supersededBy === "undefined"
          ? current.value.supersededBy
          : input.supersededBy ?? undefined,
      updatedAt,
      accessedAt: updatedAt,
    };

    const validated = validateMemoryRecord(nextRecord);
    if (!validated.ok) {
      return err(
        new MemoryRepositoryError(
          `Memory update validation failed: ${validated.error.message}`,
          "MEMORY_REPOSITORY_INVALID_INPUT",
          validated.error,
        ),
      );
    }

    const sourceMessageId = await this.getSourceMessageIdForMemory(id);
    if (!sourceMessageId.ok) {
      return sourceMessageId;
    }

    const fileName = buildFileName(nextRecord);
    const filePath = join(this.dataDir, fileName);
    const tempPath = `${filePath}.tmp-${randomUUID()}`;
    const markdown = this.serializeRecord(nextRecord, sourceMessageId.value);
    if (!markdown.ok) {
      return markdown;
    }

    const provenance: ProvenanceDetails = {
      checksum: checksumOf(markdown.value),
      fileName,
      sourceMessageId: sourceMessageId.value ?? undefined,
    };

    try {
      await mkdir(this.dataDir, { recursive: true });
      const db = this.db.getDb();
      db.exec("BEGIN IMMEDIATE");

      try {
        db.query(
          `
            UPDATE memories
            SET
              content = ?2,
              importance = ?3,
              confidence = ?4,
              tags = ?5,
              entities = ?6,
              supersedes_id = ?7,
              superseded_by_id = ?8,
              updated_at = ?9,
              last_accessed_at = ?10
            WHERE id = ?1
          `,
        ).run(
          id,
          nextRecord.content,
          nextRecord.importance,
          nextRecord.confidence,
          JSON.stringify(nextRecord.tags),
          JSON.stringify(nextRecord.entities),
          nextRecord.supersedes ?? null,
          nextRecord.supersededBy ?? null,
          nextRecord.updatedAt.toISOString(),
          nextRecord.accessedAt.toISOString(),
        );

        this.insertProvenance(db, id, "updated", provenance);
        await writeFile(tempPath, markdown.value, "utf8");
        await rename(tempPath, filePath);
        db.exec("COMMIT");
      } catch (cause) {
        this.rollback(db);
        await this.safeUnlink(tempPath);
        return err(
          new MemoryRepositoryError(
            "Failed to update memory with dual-write persistence",
            "MEMORY_REPOSITORY_IO_ERROR",
            asError(cause),
          ),
        );
      }

      return ok(nextRecord);
    } catch (cause) {
      return err(
        new MemoryRepositoryError(
          "Failed to prepare memory update",
          "MEMORY_REPOSITORY_DB_ERROR",
          asError(cause),
        ),
      );
    }
  }

  async delete(id: string): Promise<Result<void>> {
    const current = await this.getById(id);
    if (!current.ok) {
      return current;
    }

    if (!current.value) {
      return ok(undefined);
    }

    const filePath = join(this.dataDir, buildFileName(current.value));

    try {
      const db = this.db.getDb();
      db.exec("BEGIN IMMEDIATE");

      try {
        db.query("DELETE FROM memories WHERE id = ?1").run(id);
        await this.safeUnlink(filePath, true);
        db.exec("COMMIT");
      } catch (cause) {
        this.rollback(db);
        return err(
          new MemoryRepositoryError(
            "Failed to delete memory from DB and file storage",
            "MEMORY_REPOSITORY_IO_ERROR",
            asError(cause),
          ),
        );
      }

      return ok(undefined);
    } catch (cause) {
      return err(
        new MemoryRepositoryError(
          "Failed to delete memory",
          "MEMORY_REPOSITORY_DB_ERROR",
          asError(cause),
        ),
      );
    }
  }

  async list(options?: ListMemoryOptions): Promise<Result<MemoryRecord[]>> {
    try {
      const db = this.db.getDb();

      const where: string[] = [];
      const values: Array<string | number> = [];

      if (options?.type) {
        where.push("type = ?");
        values.push(options.type);
      }

      if (options?.layer) {
        where.push("layer = ?");
        values.push(options.layer);
      }

      if (options?.sourceType) {
        where.push("source_type = ?");
        values.push(options.sourceType);
      }

      let sql = `
        SELECT
          id,
          content,
          type,
          layer,
          importance,
          confidence,
          tags,
          entities,
          source_type,
          source_conversation_id,
          source_message_id,
          supersedes_id,
          superseded_by_id,
          created_at,
          updated_at,
          last_accessed_at
        FROM memories
      `;

      if (where.length > 0) {
        sql += ` WHERE ${where.join(" AND ")}`;
      }

      sql += " ORDER BY created_at DESC";

      if (typeof options?.limit !== "undefined") {
        sql += " LIMIT ?";
        values.push(options.limit);
      }

      if (typeof options?.offset !== "undefined") {
        sql += " OFFSET ?";
        values.push(options.offset);
      }

      const rows = db.query(sql).all(...values) as MemoryRow[];
      const records: MemoryRecord[] = [];

      for (const row of rows) {
        const mapped = this.mapRowToRecord(row);
        if (!mapped.ok) {
          return mapped;
        }

        records.push(mapped.value);
      }

      return ok(records);
    } catch (cause) {
      return err(
        new MemoryRepositoryError(
          "Failed to list memories",
          "MEMORY_REPOSITORY_DB_ERROR",
          asError(cause),
        ),
      );
    }
  }

  async findByType(type: MemoryType): Promise<Result<MemoryRecord[]>> {
    return this.list({ type });
  }

  async findByLayer(layer: MemoryLayer): Promise<Result<MemoryRecord[]>> {
    if (!isValidPersistedMemoryLayer(layer)) {
      return ok([]);
    }

    return this.list({ layer });
  }

  async count(): Promise<Result<number>> {
    try {
      const db = this.db.getDb();
      const row = db.query("SELECT COUNT(*) as count FROM memories").get() as CountRow;
      return ok(row.count);
    } catch (cause) {
      return err(
        new MemoryRepositoryError(
          "Failed to count memories",
          "MEMORY_REPOSITORY_DB_ERROR",
          asError(cause),
        ),
      );
    }
  }

  async reconcile(): Promise<Result<ReconciliationReport>> {
    try {
      const db = this.db.getDb();
      const dbRows = db.query("SELECT id, content FROM memories").all() as ReconciliationRow[];
      const dbContentById = new Map(dbRows.map((row) => [row.id, row.content]));

      let fileNames: string[] = [];
      try {
        fileNames = (await readdir(this.dataDir)).filter((entry) => entry.endsWith(".md"));
      } catch (cause) {
        const error = asError(cause);
        if (error && "code" in error && error.code === "ENOENT") {
          fileNames = [];
        } else {
          throw cause;
        }
      }

      const fileRecordsById = new Map<string, MemoryFileProjection>();
      const orphanedFiles: string[] = [];

      for (const fileName of fileNames) {
        const filePath = join(this.dataDir, fileName);
        const markdown = await readFile(filePath, "utf8");
        const parsed = parse(markdown);

        if (!parsed.ok) {
          orphanedFiles.push(fileName);
          continue;
        }

        fileRecordsById.set(parsed.value.id, {
          fileName,
          content: parsed.value.content,
        });

        if (!dbContentById.has(parsed.value.id)) {
          orphanedFiles.push(fileName);
        }
      }

      const missingFiles: string[] = [];
      const contentMismatches: string[] = [];

      for (const [id, dbContent] of dbContentById.entries()) {
        const fileRecord = fileRecordsById.get(id);
        if (!fileRecord) {
          missingFiles.push(id);
          continue;
        }

        if (fileRecord.content !== dbContent) {
          contentMismatches.push(id);
        }
      }

      const report: ReconciliationReport = {
        totalFiles: fileNames.length,
        totalDbRecords: dbRows.length,
        orphanedFiles,
        missingFiles,
        contentMismatches,
        isConsistent:
          orphanedFiles.length === 0 &&
          missingFiles.length === 0 &&
          contentMismatches.length === 0,
      };

      return ok(report);
    } catch (cause) {
      return err(
        new MemoryRepositoryError(
          "Failed to reconcile file and database memory states",
          "MEMORY_REPOSITORY_RECONCILIATION_ERROR",
          asError(cause),
        ),
      );
    }
  }

  private serializeRecord(record: MemoryRecord, sourceMessageId?: string | null): Result<string> {
    try {
      const fileRecord: MemoryFileRecord = {
        id: record.id,
        version: 1,
        type: record.type,
        layer: record.layer,
        importance: record.importance,
        confidence: record.confidence,
        tags: record.tags,
        entities: record.entities,
        source: {
          type: record.provenance.sourceType,
          conversationId: record.provenance.conversationId,
          messageId: sourceMessageId ?? undefined,
        },
        supersedes: record.supersedes ?? null,
        supersededBy: record.supersededBy ?? null,
        createdAt: record.createdAt.toISOString(),
        updatedAt: record.updatedAt.toISOString(),
        accessedAt: record.accessedAt.toISOString(),
        content: record.content,
      };

      return ok(serialize(fileRecord));
    } catch (cause) {
      return err(
        new MemoryRepositoryError(
          "Failed to serialize memory markdown payload",
          "MEMORY_REPOSITORY_SERIALIZATION_ERROR",
          asError(cause),
        ),
      );
    }
  }

  private mapRowToRecord(row: MemoryRow): Result<MemoryRecord> {
    if (!isValidMemorySourceType(row.source_type)) {
      return err(
        new MemoryRepositoryError(
          `Unsupported source type '${row.source_type}' found in database`,
          "MEMORY_REPOSITORY_DB_ERROR",
        ),
      );
    }

    if (!isValidPersistedMemoryLayer(row.layer)) {
      return err(
        new MemoryRepositoryError(
          `Unsupported memory layer '${row.layer}' found in database`,
          "MEMORY_REPOSITORY_DB_ERROR",
        ),
      );
    }

    const candidate: MemoryRecord = {
      id: row.id,
      content: row.content,
      type: row.type as MemoryType,
      layer: row.layer,
      tags: parseStringArray(row.tags),
      entities: parseStringArray(row.entities),
      importance: row.importance,
      confidence: row.confidence,
      provenance: {
        sourceType: row.source_type,
        conversationId: row.source_conversation_id ?? undefined,
      },
      supersedes: row.supersedes_id ?? undefined,
      supersededBy: row.superseded_by_id ?? undefined,
      createdAt: toDate(row.created_at, row.updated_at),
      updatedAt: toDate(row.updated_at, row.created_at),
      accessedAt: toDate(row.last_accessed_at, row.updated_at),
    };

    const validated = validateMemoryRecord(candidate);
    if (!validated.ok) {
      return err(
        new MemoryRepositoryError(
          `Persisted memory record failed validation: ${validated.error.message}`,
          "MEMORY_REPOSITORY_DB_ERROR",
          validated.error,
        ),
      );
    }

    return ok(validated.value);
  }

  private insertMemory(db: ReturnType<SqliteMemoryDb["getDb"]>, record: MemoryRecord, sourceMessageId?: string): void {
    db.query(
      `
        INSERT INTO memories (
          id,
          content,
          type,
          layer,
          importance,
          confidence,
          tags,
          entities,
          source_type,
          source_conversation_id,
          source_message_id,
          supersedes_id,
          superseded_by_id,
          created_at,
          updated_at,
          last_accessed_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
      `,
    ).run(
      record.id,
      record.content,
      record.type,
      record.layer,
      record.importance,
      record.confidence,
      JSON.stringify(record.tags),
      JSON.stringify(record.entities),
      record.provenance.sourceType,
      record.provenance.conversationId ?? null,
      sourceMessageId ?? null,
      record.supersedes ?? null,
      record.supersededBy ?? null,
      record.createdAt.toISOString(),
      record.updatedAt.toISOString(),
      record.accessedAt.toISOString(),
    );
  }

  private insertProvenance(
    db: ReturnType<SqliteMemoryDb["getDb"]>,
    memoryId: string,
    eventType: "created" | "updated" | "consolidated" | "superseded",
    details: ProvenanceDetails,
  ): void {
    db.query(
      `
        INSERT INTO memory_provenance (id, memory_id, event_type, source_details)
        VALUES (?1, ?2, ?3, ?4)
      `,
    ).run(randomUUID(), memoryId, eventType, JSON.stringify(details));
  }

  private async getSourceMessageIdForMemory(id: string): Promise<Result<string | null>> {
    try {
      const db = this.db.getDb();
      const row = db
        .query("SELECT source_message_id FROM memories WHERE id = ?1 LIMIT 1")
        .get(id) as { source_message_id: string | null } | null;
      return ok(row?.source_message_id ?? null);
    } catch (cause) {
      return err(
        new MemoryRepositoryError(
          "Failed to read source message id for memory",
          "MEMORY_REPOSITORY_DB_ERROR",
          asError(cause),
        ),
      );
    }
  }

  private rollback(db: ReturnType<SqliteMemoryDb["getDb"]>): void {
    try {
      db.exec("ROLLBACK");
    } catch (e) {
      // Expected: ROLLBACK may fail if no transaction is active
      log.debug("rollback failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  private async safeUnlink(path: string, ignoreMissing = false): Promise<void> {
    try {
      await unlink(path);
    } catch (cause) {
      const error = asError(cause);
      if (ignoreMissing && error && "code" in error && error.code === "ENOENT") {
        return;
      }

      throw cause;
    }
  }
}
