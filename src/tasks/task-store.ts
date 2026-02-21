import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { Database } from "bun:sqlite";

import { createLogger } from "../logger";

const log = createLogger("tasks:store");

import type {
  TaskCreateInput,
  TaskListOptions,
  TaskRecord,
  TaskStatus,
  TaskUpdateInput,
  TaskUpdateOptions,
} from "./types";

interface TaskRow {
  id: string;
  prompt: string;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  conversation_id: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  worker_id: string | null;
  delivered: number;
}

export interface SQLiteTaskStoreOptions {
  path?: string;
  now?: () => Date;
}

export interface TaskStore {
  createTask(input: TaskCreateInput): Promise<TaskRecord>;
  getTask(id: string): Promise<TaskRecord | null>;
  listTasks(options?: TaskListOptions): Promise<TaskRecord[]>;
  updateTask(id: string, input: TaskUpdateInput, options?: TaskUpdateOptions): Promise<TaskRecord | null>;
  deleteTask(id: string): Promise<boolean>;
  countUndeliveredCompleted(): Promise<number>;
  failRunningTasks(reason: string): Promise<number>;
  close(): void;
}

function isInMemoryPath(path: string): boolean {
  return path === ":memory:" || path.startsWith("file::memory:");
}

function resolveDefaultDbPath(): string {
  const home = homedir();
  const platform = process.platform;
  let root: string;

  if (platform === "darwin") {
    root = join(home, "Library", "Application Support", "reins");
  } else if (platform === "win32") {
    root = join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "reins");
  } else {
    root = join(home, ".reins");
  }

  return join(root, "tasks.db");
}

function toIso(value: Date | undefined): string | null {
  return value ? value.toISOString() : null;
}

function fromIso(value: string | null): Date | undefined {
  return value ? new Date(value) : undefined;
}

function asTaskRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    prompt: row.prompt,
    status: row.status,
    result: row.result ?? undefined,
    error: row.error ?? undefined,
    conversationId: row.conversation_id ?? undefined,
    createdAt: new Date(row.created_at),
    startedAt: fromIso(row.started_at),
    completedAt: fromIso(row.completed_at),
    workerId: row.worker_id ?? undefined,
    delivered: row.delivered === 1,
  };
}

export class SQLiteTaskStore implements TaskStore {
  public readonly path: string;

  private readonly connection: Database;
  private readonly now: () => Date;

  constructor(options: SQLiteTaskStoreOptions = {}) {
    this.path = options.path ?? resolveDefaultDbPath();
    this.now = options.now ?? (() => new Date());

    if (!isInMemoryPath(this.path)) {
      mkdirSync(dirname(this.path), { recursive: true });
    }

    this.connection = new Database(this.path, { create: true });
    this.connection.exec("PRAGMA journal_mode=WAL");
    this.connection.exec("PRAGMA foreign_keys=ON");

    this.initializeSchema();
  }

  close(): void {
    this.connection.close();
  }

  async createTask(input: TaskCreateInput): Promise<TaskRecord> {
    const createdAt = input.createdAt ?? this.now();
    const id = randomUUID();

    this.connection
      .query(
        `
          INSERT INTO tasks (
            id,
            prompt,
            status,
            result,
            error,
            conversation_id,
            created_at,
            started_at,
            completed_at,
            worker_id,
            delivered
          )
          VALUES (?1, ?2, 'pending', NULL, NULL, ?3, ?4, NULL, NULL, NULL, 0)
        `,
      )
      .run(id, input.prompt, input.conversationId ?? null, createdAt.toISOString());

    const created = await this.getTask(id);
    if (!created) {
      throw new Error(`Task ${id} was not persisted`);
    }

    return created;
  }

  async getTask(id: string): Promise<TaskRecord | null> {
    const row = this.connection
      .query(
        `
          SELECT
            id,
            prompt,
            status,
            result,
            error,
            conversation_id,
            created_at,
            started_at,
            completed_at,
            worker_id,
            delivered
          FROM tasks
          WHERE id = ?1
        `,
      )
      .get(id) as TaskRow | null;

    return row ? asTaskRecord(row) : null;
  }

  async listTasks(options: TaskListOptions = {}): Promise<TaskRecord[]> {
    const limit = typeof options.limit === "number" ? Math.max(0, options.limit) : -1;
    const offset = Math.max(0, options.offset ?? 0);

    const rows = this.connection
      .query(
        `
          SELECT
            id,
            prompt,
            status,
            result,
            error,
            conversation_id,
            created_at,
            started_at,
            completed_at,
            worker_id,
            delivered
          FROM tasks
          WHERE (?1 IS NULL OR status = ?1)
          ORDER BY created_at DESC, id DESC
          LIMIT ?2 OFFSET ?3
        `,
      )
      .all(options.status ?? null, limit, offset) as TaskRow[];

    return rows.map(asTaskRecord);
  }

  async updateTask(
    id: string,
    input: TaskUpdateInput,
    options: TaskUpdateOptions = {},
  ): Promise<TaskRecord | null> {
    const updates: string[] = [];
    const values: Array<number | string | null> = [];

    if (input.prompt !== undefined) {
      updates.push(`prompt = ?${values.length + 1}`);
      values.push(input.prompt);
    }

    if (input.status !== undefined) {
      updates.push(`status = ?${values.length + 1}`);
      values.push(input.status);
    }

    if (input.result !== undefined) {
      updates.push(`result = ?${values.length + 1}`);
      values.push(input.result);
    }

    if (input.error !== undefined) {
      updates.push(`error = ?${values.length + 1}`);
      values.push(input.error);
    }

    if (input.conversationId !== undefined) {
      updates.push(`conversation_id = ?${values.length + 1}`);
      values.push(input.conversationId);
    }

    if (input.startedAt !== undefined) {
      updates.push(`started_at = ?${values.length + 1}`);
      values.push(toIso(input.startedAt));
    }

    if (input.completedAt !== undefined) {
      updates.push(`completed_at = ?${values.length + 1}`);
      values.push(toIso(input.completedAt));
    }

    if (input.workerId !== undefined) {
      updates.push(`worker_id = ?${values.length + 1}`);
      values.push(input.workerId);
    }

    if (input.delivered !== undefined) {
      updates.push(`delivered = ?${values.length + 1}`);
      values.push(input.delivered ? 1 : 0);
    }

    if (updates.length === 0) {
      return this.getTask(id);
    }

    const idPlaceholder = `?${values.length + 1}`;
    values.push(id);

    let sql = `UPDATE tasks SET ${updates.join(", ")} WHERE id = ${idPlaceholder}`;
    if (options.expectedStatus !== undefined) {
      const expectedStatusPlaceholder = `?${values.length + 1}`;
      sql = `${sql} AND status = ${expectedStatusPlaceholder}`;
      values.push(options.expectedStatus);
    }

    const result = this.connection.query(sql).run(...values);
    if (result.changes === 0) {
      return null;
    }

    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    const result = this.connection.query("DELETE FROM tasks WHERE id = ?1").run(id);
    return result.changes > 0;
  }

  async countUndeliveredCompleted(): Promise<number> {
    const row = this.connection
      .query(
        `
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE delivered = 0 AND status = 'complete'
        `,
      )
      .get() as { count: number };

    return row.count;
  }

  async failRunningTasks(reason: string): Promise<number> {
    const completedAt = this.now().toISOString();

    this.connection.exec("BEGIN IMMEDIATE");
    try {
      const result = this.connection
        .query(
          `
            UPDATE tasks
            SET
              status = 'failed',
              error = ?1,
              completed_at = ?2
            WHERE status = 'running'
          `,
        )
        .run(reason, completedAt);

      this.connection.exec("COMMIT");
      return result.changes;
    } catch (error) {
      this.safeRollback();
      throw error;
    }
  }

  private initializeSchema(): void {
    this.connection.exec("BEGIN IMMEDIATE");
    try {
      this.connection.exec(`
        CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'complete', 'failed')),
          result TEXT,
          error TEXT,
          conversation_id TEXT,
          created_at TEXT NOT NULL,
          started_at TEXT,
          completed_at TEXT,
          worker_id TEXT,
          delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0, 1))
        );

        CREATE INDEX IF NOT EXISTS idx_tasks_status_created
          ON tasks(status, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_tasks_delivered_status
          ON tasks(delivered, status, completed_at DESC);
      `);
      this.connection.exec("COMMIT");
    } catch (error) {
      this.safeRollback();
      throw error;
    }
  }

  private safeRollback(): void {
    try {
      this.connection.exec("ROLLBACK");
    } catch (e) {
      // Expected: ROLLBACK may fail if no transaction is active
      log.debug("rollback failed", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
