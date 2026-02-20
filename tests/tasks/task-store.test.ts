import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { SQLiteTaskStore } from "../../src/tasks/task-store";

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "reins-task-store-"));
  const dbPath = join(directory, "tasks.db");

  try {
    await run(dbPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("SQLiteTaskStore", () => {
  test("creates database with WAL mode enabled", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      store.close();

      const db = new Database(dbPath);
      const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(row.journal_mode.toLowerCase()).toBe("wal");
      db.close();
    });
  });

  test("supports task CRUD and state transitions", async () => {
    await withTempDb(async (dbPath) => {
      const now = new Date("2026-02-19T18:00:00.000Z");
      const store = new SQLiteTaskStore({
        path: dbPath,
        now: () => now,
      });

      const created = await store.createTask({
        prompt: "Generate weekly update",
        conversationId: "conv-123",
      });

      expect(created.status).toBe("pending");
      expect(created.delivered).toBe(false);
      expect(created.conversationId).toBe("conv-123");

      const runningAt = new Date("2026-02-19T18:01:00.000Z");
      const running = await store.updateTask(
        created.id,
        {
          status: "running",
          startedAt: runningAt,
          workerId: "worker-a",
        },
        { expectedStatus: "pending" },
      );

      expect(running).not.toBeNull();
      expect(running?.status).toBe("running");
      expect(running?.startedAt?.toISOString()).toBe(runningAt.toISOString());
      expect(running?.workerId).toBe("worker-a");

      const staleTransition = await store.updateTask(
        created.id,
        { status: "failed", error: "stale update" },
        { expectedStatus: "pending" },
      );
      expect(staleTransition).toBeNull();

      const completedAt = new Date("2026-02-19T18:02:00.000Z");
      const completed = await store.updateTask(
        created.id,
        {
          status: "complete",
          result: "Weekly update complete",
          completedAt,
          delivered: false,
        },
        { expectedStatus: "running" },
      );

      expect(completed).not.toBeNull();
      expect(completed?.status).toBe("complete");
      expect(completed?.result).toBe("Weekly update complete");
      expect(completed?.completedAt?.toISOString()).toBe(completedAt.toISOString());

      const count = await store.countUndeliveredCompleted();
      expect(count).toBe(1);

      const loaded = await store.getTask(created.id);
      expect(loaded).not.toBeNull();
      expect(loaded?.status).toBe("complete");

      const listed = await store.listTasks();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.id).toBe(created.id);

      const failed = await store.updateTask(created.id, {
        status: "failed",
        error: "manual failure",
      });
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toBe("manual failure");

      const deleted = await store.deleteTask(created.id);
      expect(deleted).toBe(true);

      const afterDelete = await store.getTask(created.id);
      expect(afterDelete).toBeNull();

      store.close();
    });
  });

  test("fails running tasks with daemon restart reason", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });

      const pending = await store.createTask({ prompt: "pending" });
      const running = await store.createTask({ prompt: "running" });

      await store.updateTask(running.id, {
        status: "running",
        startedAt: new Date("2026-02-19T18:10:00.000Z"),
      });

      const failedCount = await store.failRunningTasks("daemon restart");
      expect(failedCount).toBe(1);

      const pendingAfter = await store.getTask(pending.id);
      expect(pendingAfter?.status).toBe("pending");

      const runningAfter = await store.getTask(running.id);
      expect(runningAfter?.status).toBe("failed");
      expect(runningAfter?.error).toBe("daemon restart");
      expect(runningAfter?.completedAt).toBeDefined();

      store.close();
    });
  });

  test("migration is idempotent across multiple opens", async () => {
    await withTempDb(async (dbPath) => {
      const first = new SQLiteTaskStore({ path: dbPath });
      first.close();

      const second = new SQLiteTaskStore({ path: dbPath });
      second.close();

      const db = new Database(dbPath);

      const tableRows = db
        .query(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table'
              AND name = 'tasks'
          `,
        )
        .all() as Array<{ name: string }>;
      expect(tableRows).toHaveLength(1);

      const columns = db.query("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).toEqual([
        "id",
        "prompt",
        "status",
        "result",
        "error",
        "conversation_id",
        "created_at",
        "started_at",
        "completed_at",
        "worker_id",
        "delivered",
      ]);

      db.close();
    });
  });
});
