import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { handleTaskCommand } from "../../src/tasks/task-command";
import { TaskQueue } from "../../src/tasks/task-queue";
import { SQLiteTaskStore } from "../../src/tasks/task-store";

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "reins-task-cmd-"));
  const dbPath = join(directory, "tasks.db");

  try {
    await run(dbPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("handleTaskCommand", () => {
  test("creates a pending task from description", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const result = await handleTaskCommand("research quantum computing", queue);

      expect(result.success).toBe(true);
      expect(result.taskId).toBeDefined();
      expect(result.message).toContain("research quantum computing");
      expect(result.task).toBeDefined();
      expect(result.task?.status).toBe("pending");
      expect(result.task?.prompt).toBe("research quantum computing");

      store.close();
    });
  });

  test("task appears in queue immediately after creation", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const result = await handleTaskCommand("summarize meeting notes", queue);
      expect(result.success).toBe(true);

      const tasks = await queue.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.id).toBe(result.taskId);
      expect(tasks[0]?.prompt).toBe("summarize meeting notes");
      expect(tasks[0]?.status).toBe("pending");

      store.close();
    });
  });

  test("returns a valid task ID", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const result = await handleTaskCommand("draft email to team", queue);

      expect(result.success).toBe(true);
      expect(typeof result.taskId).toBe("string");
      expect(result.taskId!.length).toBeGreaterThan(0);

      const fetched = await queue.getTask(result.taskId!);
      expect(fetched).not.toBeNull();
      expect(fetched?.prompt).toBe("draft email to team");

      store.close();
    });
  });

  test("links conversation ID when provided", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const result = await handleTaskCommand(
        "analyze sales data",
        queue,
        "conv-abc-123",
      );

      expect(result.success).toBe(true);
      expect(result.task?.conversationId).toBe("conv-abc-123");

      const fetched = await queue.getTask(result.taskId!);
      expect(fetched?.conversationId).toBe("conv-abc-123");

      store.close();
    });
  });

  test("works without conversation ID", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const result = await handleTaskCommand("check weather forecast", queue);

      expect(result.success).toBe(true);
      expect(result.task?.conversationId).toBeUndefined();

      store.close();
    });
  });

  test("returns failure for empty description", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const result = await handleTaskCommand("", queue);

      expect(result.success).toBe(false);
      expect(result.taskId).toBeUndefined();
      expect(result.task).toBeUndefined();
      expect(result.message).toContain("Usage");

      const tasks = await queue.list();
      expect(tasks).toHaveLength(0);

      store.close();
    });
  });

  test("returns failure for whitespace-only description", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const result = await handleTaskCommand("   \t\n  ", queue);

      expect(result.success).toBe(false);
      expect(result.taskId).toBeUndefined();

      const tasks = await queue.list();
      expect(tasks).toHaveLength(0);

      store.close();
    });
  });

  test("trims leading and trailing whitespace from description", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const result = await handleTaskCommand("  research AI trends  ", queue);

      expect(result.success).toBe(true);
      expect(result.task?.prompt).toBe("research AI trends");

      store.close();
    });
  });

  test("confirmation message includes task ID", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const result = await handleTaskCommand("compile weekly report", queue);

      expect(result.success).toBe(true);
      expect(result.message).toContain(result.taskId!);

      store.close();
    });
  });

  test("creates multiple independent tasks", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const first = await handleTaskCommand("task one", queue, "conv-1");
      const second = await handleTaskCommand("task two", queue, "conv-1");
      const third = await handleTaskCommand("task three", queue, "conv-2");

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(third.success).toBe(true);

      expect(first.taskId).not.toBe(second.taskId);
      expect(second.taskId).not.toBe(third.taskId);

      const tasks = await queue.list();
      expect(tasks).toHaveLength(3);

      store.close();
    });
  });
});
