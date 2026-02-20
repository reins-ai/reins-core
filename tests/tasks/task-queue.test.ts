import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskQueue } from "../../src/tasks/task-queue";
import { SQLiteTaskStore } from "../../src/tasks/task-store";

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "reins-task-queue-"));
  const dbPath = join(directory, "tasks.db");

  try {
    await run(dbPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("TaskQueue", () => {
  test("runs enqueue -> dequeue -> complete lifecycle", async () => {
    await withTempDb(async (dbPath) => {
      const now = new Date("2026-02-19T20:00:00.000Z");
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store, { now: () => now });

      const created = await queue.enqueue({
        prompt: "Summarize today's work",
        conversationId: "conv-1",
      });
      expect(created.status).toBe("pending");

      const running = await queue.dequeue("worker-1");
      expect(running).not.toBeNull();
      expect(running?.id).toBe(created.id);
      expect(running?.status).toBe("running");
      expect(running?.workerId).toBe("worker-1");
      expect(running?.startedAt?.toISOString()).toBe(now.toISOString());

      const completed = await queue.complete(created.id, "Done");
      expect(completed).not.toBeNull();
      expect(completed?.status).toBe("complete");
      expect(completed?.result).toBe("Done");
      expect(completed?.completedAt?.toISOString()).toBe(now.toISOString());

      const listed = await queue.list();
      expect(listed).toHaveLength(1);
      expect(listed[0]?.status).toBe("complete");

      store.close();
    });
  });

  test("retries failed task with original prompt", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      const original = await queue.enqueue({
        prompt: "Generate weekly report",
        conversationId: "conv-42",
      });

      const running = await queue.dequeue();
      expect(running?.id).toBe(original.id);

      const failed = await queue.fail(original.id, "timeout");
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toBe("timeout");

      const retried = await queue.retry(original.id);
      expect(retried).not.toBeNull();
      expect(retried?.id).not.toBe(original.id);
      expect(retried?.status).toBe("pending");
      expect(retried?.prompt).toBe(original.prompt);
      expect(retried?.conversationId).toBe(original.conversationId);

      const retryOfPending = await queue.retry(retried?.id ?? "");
      expect(retryOfPending).toBeNull();

      store.close();
    });
  });

  test("recoverFromRestart marks running tasks as failed", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);

      await queue.enqueue({
        prompt: "running task",
        createdAt: new Date("2026-02-19T20:00:00.000Z"),
      });
      const pending = await queue.enqueue({
        prompt: "pending task",
        createdAt: new Date("2026-02-19T20:01:00.000Z"),
      });
      const running = await queue.dequeue("worker-2");
      expect(running?.status).toBe("running");

      const failedCount = await queue.recoverFromRestart();
      expect(failedCount).toBe(1);

      const pendingAfter = await store.getTask(pending.id);
      expect(pendingAfter?.status).toBe("pending");

      const runningAfter = await store.getTask(running?.id ?? "");
      expect(runningAfter?.status).toBe("failed");
      expect(runningAfter?.error).toBe("daemon restart");

      store.close();
    });
  });

  test("history persists across simulated restarts", async () => {
    await withTempDb(async (dbPath) => {
      const firstStore = new SQLiteTaskStore({ path: dbPath });
      const firstQueue = new TaskQueue(firstStore);

      const completedTask = await firstQueue.enqueue({ prompt: "completed" });
      await firstQueue.dequeue("worker-a");
      await firstQueue.complete(completedTask.id, "complete result");

      await firstQueue.enqueue({ prompt: "will fail on restart" });
      const runningTask = await firstQueue.dequeue("worker-b");
      expect(runningTask?.status).toBe("running");

      firstStore.close();

      const secondStore = new SQLiteTaskStore({ path: dbPath });
      const secondQueue = new TaskQueue(secondStore);
      const recovered = await secondQueue.recoverFromRestart();
      expect(recovered).toBe(1);

      const failedAfterRecovery = await secondStore.getTask(runningTask?.id ?? "");
      expect(failedAfterRecovery?.status).toBe("failed");
      expect(failedAfterRecovery?.error).toBe("daemon restart");

      const retried = await secondQueue.retry(runningTask?.id ?? "");
      expect(retried?.status).toBe("pending");
      expect(retried?.prompt).toBe("will fail on restart");

      secondStore.close();

      const thirdStore = new SQLiteTaskStore({ path: dbPath });
      const thirdQueue = new TaskQueue(thirdStore);
      const history = await thirdQueue.list();

      expect(history).toHaveLength(3);
      expect(history.some((task) => task.status === "complete")).toBe(true);
      expect(history.some((task) => task.status === "failed" && task.error === "daemon restart")).toBe(
        true,
      );
      expect(history.some((task) => task.status === "pending" && task.prompt === "will fail on restart")).toBe(
        true,
      );

      thirdStore.close();
    });
  });
});
