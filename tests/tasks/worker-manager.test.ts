import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../../src/harness/agent-loop";
import { FULL_PROFILE, PermissionChecker } from "../../src/harness/permissions";
import { ProviderRegistry } from "../../src/providers";
import { TaskQueue } from "../../src/tasks/task-queue";
import { SQLiteTaskStore } from "../../src/tasks/task-store";
import { WorkerManager } from "../../src/tasks/worker-manager";
import type { WorkerRunContext } from "../../src/tasks/worker-manager";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined;
  let reject: ((error?: unknown) => void) | undefined;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  if (!resolve || !reject) {
    throw new Error("Failed to create deferred");
  }

  return { promise, resolve, reject };
}

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "reins-worker-manager-"));
  const dbPath = join(directory, "tasks.db");

  try {
    await run(dbPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 500,
  intervalMs = 10,
): Promise<void> {
  const started = Date.now();

  while (Date.now() - started <= timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise<void>((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  throw new Error("Timed out waiting for condition");
}

describe("WorkerManager", () => {
  test("isolates workers so cancelling one does not affect others", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);
      const providerRegistry = new ProviderRegistry();
      const permissionChecker = new PermissionChecker(FULL_PROFILE);

      const task1 = await queue.enqueue({ prompt: "task-1" });
      const task2 = await queue.enqueue({ prompt: "task-2" });

      const contexts = new Map<string, WorkerRunContext>();
      const completions = new Map<string, Deferred<string>>();
      completions.set(task1.id, createDeferred<string>());
      completions.set(task2.id, createDeferred<string>());

      const manager = new WorkerManager(queue, providerRegistry, permissionChecker, {
        runTask: async (context) => {
          contexts.set(context.task.id, context);
          const completion = completions.get(context.task.id);
          if (!completion) {
            throw new Error(`Missing completion handle for task ${context.task.id}`);
          }

          return await new Promise<string>((resolve, reject) => {
            const onAbort = () => {
              reject(new Error("aborted"));
            };

            context.abortSignal.addEventListener("abort", onAbort, { once: true });
            completion.promise
              .then(resolve)
              .catch(reject)
              .finally(() => {
                context.abortSignal.removeEventListener("abort", onAbort);
              });
          });
        },
      });

      await manager.spawn(task1.id);
      await manager.spawn(task2.id);

      await waitFor(() => manager.getStatus().runningCount === 2);

      const firstContext = contexts.get(task1.id);
      const secondContext = contexts.get(task2.id);
      expect(firstContext).toBeDefined();
      expect(secondContext).toBeDefined();
      expect(firstContext?.agentLoop).not.toBe(secondContext?.agentLoop);
      expect(firstContext?.toolExecutor).not.toBe(secondContext?.toolExecutor);
      expect(firstContext?.abortSignal).not.toBe(secondContext?.abortSignal);
      expect(firstContext?.providerRegistry).toBe(providerRegistry);
      expect(secondContext?.providerRegistry).toBe(providerRegistry);
      expect(firstContext?.permissionChecker).toBe(permissionChecker);
      expect(secondContext?.permissionChecker).toBe(permissionChecker);

      expect(manager.cancel(task1.id)).toBe(true);

      await waitFor(async () => {
        const failedTask = await queue.getTask(task1.id);
        return failedTask?.status === "failed" && failedTask.error === "cancelled";
      });

      const runningTask = await queue.getTask(task2.id);
      expect(runningTask?.status).toBe("running");

      completions.get(task2.id)?.resolve("task-2-done");

      await waitFor(async () => {
        const completedTask = await queue.getTask(task2.id);
        return completedTask?.status === "complete";
      });

      // Wait for all workers to fully complete (including finally block)
      await waitFor(() => manager.getStatus().runningCount === 0);

      store.close();
    });
  });

  test("enforces max concurrency and keeps the 4th task pending", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);
      const providerRegistry = new ProviderRegistry();
      const permissionChecker = new PermissionChecker(FULL_PROFILE);

      const tasks = await Promise.all([
        queue.enqueue({ prompt: "task-a" }),
        queue.enqueue({ prompt: "task-b" }),
        queue.enqueue({ prompt: "task-c" }),
        queue.enqueue({ prompt: "task-d" }),
      ]);

      const completions = new Map<string, Deferred<string>>();
      for (const task of tasks) {
        completions.set(task.id, createDeferred<string>());
      }

      const manager = new WorkerManager(queue, providerRegistry, permissionChecker, {
        maxConcurrentWorkers: 3,
        runTask: async (context) => {
          const completion = completions.get(context.task.id);
          if (!completion) {
            throw new Error(`Missing completion for task ${context.task.id}`);
          }

          return await new Promise<string>((resolve, reject) => {
            const onAbort = () => reject(new Error("aborted"));
            context.abortSignal.addEventListener("abort", onAbort, { once: true });
            completion.promise
              .then(resolve)
              .catch(reject)
              .finally(() => {
                context.abortSignal.removeEventListener("abort", onAbort);
              });
          });
        },
      });

      for (const task of tasks) {
        await manager.spawn(task.id);
      }

      await waitFor(() => manager.getStatus().runningCount === 3);

      const fourthTaskId = tasks[3]?.id;
      expect(fourthTaskId).toBeDefined();
      expect(manager.getStatus().pendingTaskIds).toContain(fourthTaskId);

      const fourthBefore = await queue.getTask(fourthTaskId ?? "");
      expect(fourthBefore?.status).toBe("pending");

      const [firstRunningTaskId] = manager.getStatus().runningTaskIds;
      expect(firstRunningTaskId).toBeDefined();
      completions.get(firstRunningTaskId ?? "")?.resolve("done");

      await waitFor(async () => {
        const fourthAfter = await queue.getTask(fourthTaskId ?? "");
        return fourthAfter?.status === "running";
      });

      for (const completion of completions.values()) {
        completion.resolve("cleanup");
      }

      await waitFor(() => manager.getStatus().runningCount === 0, 1_000);

      store.close();
    });
  });

  test("loads max concurrency from ~/.reins/config.json", async () => {
    await withTempDb(async (dbPath) => {
      const tempConfigDir = await mkdtemp(join(tmpdir(), "reins-worker-config-"));
      const configPath = join(tempConfigDir, "config.json");

      try {
        await mkdir(tempConfigDir, { recursive: true });
        await writeFile(
          configPath,
          `${JSON.stringify({
            name: "config-user",
            provider: { mode: "none" },
            daemon: { host: "localhost", port: 7433 },
            tasks: { maxConcurrentWorkers: 2 },
            setupComplete: true,
          }, null, 2)}\n`,
          "utf8",
        );

        const store = new SQLiteTaskStore({ path: dbPath });
        const queue = new TaskQueue(store);
        const providerRegistry = new ProviderRegistry();
        const permissionChecker = new PermissionChecker(FULL_PROFILE);

        const tasks = await Promise.all([
          queue.enqueue({ prompt: "task-1" }),
          queue.enqueue({ prompt: "task-2" }),
          queue.enqueue({ prompt: "task-3" }),
        ]);

        const completions = new Map<string, Deferred<string>>();
        for (const task of tasks) {
          completions.set(task.id, createDeferred<string>());
        }

        const manager = new WorkerManager(queue, providerRegistry, permissionChecker, {
          readUserConfig: async () => {
            const raw = await Bun.file(configPath).json() as {
              tasks?: { maxConcurrentWorkers?: number };
            };

            return {
              name: "config-user",
              provider: { mode: "none" as const },
              daemon: { host: "localhost", port: 7433 },
              setupComplete: true,
              tasks: {
                maxConcurrentWorkers: raw.tasks?.maxConcurrentWorkers,
              },
            };
          },
          runTask: async (context) => {
            const completion = completions.get(context.task.id);
            if (!completion) {
              throw new Error(`Missing completion for task ${context.task.id}`);
            }

            return await completion.promise;
          },
        });

        for (const task of tasks) {
          await manager.spawn(task.id);
        }

        await waitFor(() => manager.getStatus().runningCount === 2);

        expect(manager.getStatus().maxConcurrentWorkers).toBe(2);
        expect(manager.getStatus().pendingTaskIds).toHaveLength(1);

        for (const completion of completions.values()) {
          completion.resolve("done");
        }

        await waitFor(() => manager.getStatus().runningCount === 0, 1_000);

        store.close();
      } finally {
        await rm(tempConfigDir, { recursive: true, force: true });
      }
    });
  });

  test("marks timed out workers as failed with timeout reason", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);
      const providerRegistry = new ProviderRegistry();
      const permissionChecker = new PermissionChecker(FULL_PROFILE);

      const task = await queue.enqueue({ prompt: "timeout task" });

      const manager = new WorkerManager(queue, providerRegistry, permissionChecker, {
        workerTimeoutMs: 20,
        runTask: async (context) =>
          await new Promise<string>((_, reject) => {
            context.abortSignal.addEventListener(
              "abort",
              () => {
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
      });

      await manager.spawn(task.id);

      await waitFor(async () => {
        const updated = await queue.getTask(task.id);
        return updated?.status === "failed" && updated.error === "timeout";
      }, 1_000);

      // Wait for worker to fully complete (including finally block)
      await waitFor(() => manager.getStatus().runningCount === 0);

      store.close();
    });
  });

  test("uses the same permission checker instance as foreground", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);
      const providerRegistry = new ProviderRegistry();
      const permissionChecker = new PermissionChecker(FULL_PROFILE);

      const task = await queue.enqueue({ prompt: "permission task" });

      const loopCheckers: PermissionChecker[] = [];
      const runCheckers: PermissionChecker[] = [];

      const manager = new WorkerManager(queue, providerRegistry, permissionChecker, {
        createAgentLoop: ({ signal, permissionChecker: checker }) => {
          loopCheckers.push(checker);
          return new AgentLoop({ signal, permissionChecker: checker });
        },
        runTask: async (context) => {
          runCheckers.push(context.permissionChecker);
          return "done";
        },
      });

      await manager.spawn(task.id);

      await waitFor(async () => {
        const completed = await queue.getTask(task.id);
        return completed?.status === "complete";
      });

      // Wait for worker to fully complete (including finally block)
      await waitFor(() => manager.getStatus().runningCount === 0);

      expect(loopCheckers).toHaveLength(1);
      expect(runCheckers).toHaveLength(1);
      expect(loopCheckers[0]).toBe(permissionChecker);
      expect(runCheckers[0]).toBe(permissionChecker);

      store.close();
    });
  });
});
