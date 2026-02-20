import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentLoop } from "../../src/harness/agent-loop";
import {
  FULL_PROFILE,
  MINIMAL_PROFILE,
  PermissionChecker,
  STANDARD_PROFILE,
} from "../../src/harness/permissions";
import type { PermissionProfile } from "../../src/harness/permissions";
import { ProviderRegistry } from "../../src/providers";
import { ChannelRegistry } from "../../src/channels/registry";
import type { Channel, ChannelMessage } from "../../src/channels/types";
import { TaskDeliveryPipeline } from "../../src/tasks/delivery-pipeline";
import type { TaskDeliveryWebSocketTransport } from "../../src/tasks/delivery-pipeline";
import { TaskQueue } from "../../src/tasks/task-queue";
import { SQLiteTaskStore } from "../../src/tasks/task-store";
import { WorkerManager } from "../../src/tasks/worker-manager";
import type { WorkerFactoryContext, WorkerRunContext } from "../../src/tasks/worker-manager";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
  const directory = await mkdtemp(join(tmpdir(), "reins-task-integration-"));
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

function createMockChannel(id: string): {
  channel: Channel;
  sentMessages: ChannelMessage[];
} {
  const sentMessages: ChannelMessage[] = [];

  const channel: Channel = {
    config: {
      id,
      platform: "telegram",
      tokenReference: `token-${id}`,
      enabled: true,
    },
    status: {
      state: "connected",
      uptimeMs: 1000,
    },
    async connect() {
      // no-op
    },
    async disconnect() {
      // no-op
    },
    async send(message: ChannelMessage) {
      sentMessages.push(message);
    },
    onMessage() {
      return () => {
        // no-op
      };
    },
  };

  return { channel, sentMessages };
}

function createWebSocketTransport(connected: boolean): {
  transport: TaskDeliveryWebSocketTransport;
  sentMessages: Array<{ taskId: string; conversationId?: string; content: string }>;
} {
  const sentMessages: Array<{ taskId: string; conversationId?: string; content: string }> = [];

  const transport: TaskDeliveryWebSocketTransport = {
    isConnected: () => connected,
    async sendAssistantMessage(message) {
      sentMessages.push(message);
    },
  };

  return { transport, sentMessages };
}

async function markTaskComplete(store: SQLiteTaskStore, taskId: string): Promise<void> {
  const updated = await store.updateTask(taskId, {
    status: "complete",
    result: "completed",
    completedAt: new Date("2026-02-20T10:00:00.000Z"),
    delivered: false,
  });

  if (!updated) {
    throw new Error(`Failed to mark task ${taskId} complete`);
  }
}

// ---------------------------------------------------------------------------
// Security: Worker permission policy matches foreground
// ---------------------------------------------------------------------------

describe("Task queue security boundaries", () => {
  test("worker AgentLoop receives the same PermissionChecker instance as foreground", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);
      const providerRegistry = new ProviderRegistry();
      const foregroundChecker = new PermissionChecker(FULL_PROFILE);

      const task = await queue.enqueue({ prompt: "security check task" });

      const capturedLoopCheckers: PermissionChecker[] = [];
      const capturedRunCheckers: PermissionChecker[] = [];

      const manager = new WorkerManager(queue, providerRegistry, foregroundChecker, {
        createAgentLoop: ({ signal, permissionChecker }: WorkerFactoryContext) => {
          capturedLoopCheckers.push(permissionChecker);
          return new AgentLoop({ signal, permissionChecker });
        },
        runTask: async (context: WorkerRunContext) => {
          capturedRunCheckers.push(context.permissionChecker);
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

      expect(capturedLoopCheckers).toHaveLength(1);
      expect(capturedRunCheckers).toHaveLength(1);
      expect(capturedLoopCheckers[0]).toBe(foregroundChecker);
      expect(capturedRunCheckers[0]).toBe(foregroundChecker);

      store.close();
    });
  });

  test("workers under restrictive profile enforce the same tool restrictions", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);
      const providerRegistry = new ProviderRegistry();

      const restrictiveProfile: PermissionProfile = {
        name: "minimal",
        defaultAction: "deny",
        rules: {
          voice: "allow",
        },
      };
      const foregroundChecker = new PermissionChecker(restrictiveProfile);

      const task = await queue.enqueue({ prompt: "restricted task" });

      const workerCheckResults: Array<{ toolName: string; action: string }> = [];

      const manager = new WorkerManager(queue, providerRegistry, foregroundChecker, {
        runTask: async (context: WorkerRunContext) => {
          const voiceResult = context.permissionChecker.check({ name: "voice", arguments: {} });
          const calendarResult = context.permissionChecker.check({ name: "calendar", arguments: {} });
          const notesResult = context.permissionChecker.check({ name: "notes", arguments: {} });

          workerCheckResults.push(
            { toolName: "voice", action: voiceResult.action },
            { toolName: "calendar", action: calendarResult.action },
            { toolName: "notes", action: notesResult.action },
          );

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

      // Foreground checks
      const fgVoice = foregroundChecker.check({ name: "voice", arguments: {} });
      const fgCalendar = foregroundChecker.check({ name: "calendar", arguments: {} });
      const fgNotes = foregroundChecker.check({ name: "notes", arguments: {} });

      // Worker results must match foreground
      expect(workerCheckResults).toHaveLength(3);
      expect(workerCheckResults[0]?.action).toBe(fgVoice.action);
      expect(workerCheckResults[1]?.action).toBe(fgCalendar.action);
      expect(workerCheckResults[2]?.action).toBe(fgNotes.action);

      // Verify the actual policy: voice allowed, everything else denied
      expect(fgVoice.action).toBe("allow");
      expect(fgCalendar.action).toBe("deny");
      expect(fgNotes.action).toBe("deny");

      store.close();
    });
  });

  test("multiple concurrent workers all share the same PermissionChecker", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);
      const providerRegistry = new ProviderRegistry();
      const foregroundChecker = new PermissionChecker(STANDARD_PROFILE);

      const task1 = await queue.enqueue({ prompt: "worker-1 task" });
      const task2 = await queue.enqueue({ prompt: "worker-2 task" });
      const task3 = await queue.enqueue({ prompt: "worker-3 task" });

      const checkersByTaskId = new Map<string, PermissionChecker>();
      const completions = new Map<string, Deferred<string>>();
      completions.set(task1.id, createDeferred<string>());
      completions.set(task2.id, createDeferred<string>());
      completions.set(task3.id, createDeferred<string>());

      const manager = new WorkerManager(queue, providerRegistry, foregroundChecker, {
        maxConcurrentWorkers: 3,
        runTask: async (context: WorkerRunContext) => {
          checkersByTaskId.set(context.task.id, context.permissionChecker);
          const completion = completions.get(context.task.id);
          if (!completion) {
            throw new Error(`Missing completion for ${context.task.id}`);
          }
          return completion.promise;
        },
      });

      await manager.spawn(task1.id);
      await manager.spawn(task2.id);
      await manager.spawn(task3.id);

      await waitFor(() => manager.getStatus().runningCount === 3);

      // All three workers must reference the exact same PermissionChecker
      expect(checkersByTaskId.get(task1.id)).toBe(foregroundChecker);
      expect(checkersByTaskId.get(task2.id)).toBe(foregroundChecker);
      expect(checkersByTaskId.get(task3.id)).toBe(foregroundChecker);

      // Clean up
      for (const completion of completions.values()) {
        completion.resolve("done");
      }
      await waitFor(() => manager.getStatus().runningCount === 0, 1_000);

      store.close();
    });
  });

  test("no privilege escalation: worker cannot bypass foreground restrictions", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);
      const providerRegistry = new ProviderRegistry();
      const minimalChecker = new PermissionChecker(MINIMAL_PROFILE);

      const task = await queue.enqueue({ prompt: "escalation attempt" });

      let workerCheckerProfile: string | undefined;
      let scheduleAction: string | undefined;

      const manager = new WorkerManager(queue, providerRegistry, minimalChecker, {
        runTask: async (context: WorkerRunContext) => {
          const result = context.permissionChecker.check({ name: "schedule", arguments: {} });
          workerCheckerProfile = result.profile;
          scheduleAction = result.action;
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

      // Worker must use the minimal profile, not an escalated one
      expect(workerCheckerProfile).toBe("minimal");
      expect(scheduleAction).toBe("deny");

      store.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Persistence: Queue survives restart
// ---------------------------------------------------------------------------

describe("Task queue persistence across restart", () => {
  test("tasks persist in SQLite and survive simulated restart", async () => {
    await withTempDb(async (dbPath) => {
      // Session 1: enqueue tasks and complete one
      const store1 = new SQLiteTaskStore({ path: dbPath });
      const queue1 = new TaskQueue(store1);

      const taskA = await queue1.enqueue({ prompt: "persist-task-A", conversationId: "conv-1" });
      const taskB = await queue1.enqueue({ prompt: "persist-task-B" });

      // Use start() to explicitly claim taskA, then complete it
      await queue1.start(taskA.id, "worker-1");
      await queue1.complete(taskA.id, "Result A");

      // Verify state before "restart"
      const beforeRestart = await queue1.list();
      expect(beforeRestart).toHaveLength(2);

      const completedBefore = beforeRestart.find((t) => t.id === taskA.id);
      expect(completedBefore?.status).toBe("complete");
      expect(completedBefore?.result).toBe("Result A");

      const pendingBefore = beforeRestart.find((t) => t.id === taskB.id);
      expect(pendingBefore?.status).toBe("pending");

      store1.close();

      // Session 2: reopen the same database (simulated restart)
      const store2 = new SQLiteTaskStore({ path: dbPath });
      const queue2 = new TaskQueue(store2);

      const afterRestart = await queue2.list();
      expect(afterRestart).toHaveLength(2);

      const completedAfter = afterRestart.find((t) => t.id === taskA.id);
      expect(completedAfter?.status).toBe("complete");
      expect(completedAfter?.result).toBe("Result A");
      expect(completedAfter?.conversationId).toBe("conv-1");

      const pendingAfter = afterRestart.find((t) => t.id === taskB.id);
      expect(pendingAfter?.status).toBe("pending");
      expect(pendingAfter?.prompt).toBe("persist-task-B");

      store2.close();
    });
  });

  test("running tasks are marked failed with 'daemon restart' on recovery", async () => {
    await withTempDb(async (dbPath) => {
      // Session 1: enqueue and start tasks, then "crash" without completing
      const store1 = new SQLiteTaskStore({ path: dbPath });
      const queue1 = new TaskQueue(store1);

      const taskA = await queue1.enqueue({ prompt: "running-task-A" });
      const taskB = await queue1.enqueue({ prompt: "running-task-B" });
      const taskC = await queue1.enqueue({ prompt: "pending-task-C" });

      // Explicitly start two tasks by ID (simulate workers claiming them)
      await queue1.start(taskA.id, "worker-1");
      await queue1.start(taskB.id, "worker-2");

      // Verify both are running before "crash"
      const runningA = await queue1.getTask(taskA.id);
      const runningB = await queue1.getTask(taskB.id);
      const pendingC = await queue1.getTask(taskC.id);
      expect(runningA?.status).toBe("running");
      expect(runningB?.status).toBe("running");
      expect(pendingC?.status).toBe("pending");

      store1.close();

      // Session 2: simulate daemon restart with recovery
      const store2 = new SQLiteTaskStore({ path: dbPath });
      const queue2 = new TaskQueue(store2);

      const recoveredCount = await queue2.recoverFromRestart();
      expect(recoveredCount).toBe(2);

      const recoveredA = await queue2.getTask(taskA.id);
      const recoveredB = await queue2.getTask(taskB.id);
      const recoveredC = await queue2.getTask(taskC.id);

      expect(recoveredA?.status).toBe("failed");
      expect(recoveredA?.error).toBe("daemon restart");
      expect(recoveredA?.completedAt).toBeDefined();

      expect(recoveredB?.status).toBe("failed");
      expect(recoveredB?.error).toBe("daemon restart");
      expect(recoveredB?.completedAt).toBeDefined();

      // Pending task should remain unaffected
      expect(recoveredC?.status).toBe("pending");
      expect(recoveredC?.error).toBeUndefined();

      store2.close();
    });
  });

  test("failed tasks from restart are retryable", async () => {
    await withTempDb(async (dbPath) => {
      // Session 1: create a running task, then "crash"
      const store1 = new SQLiteTaskStore({ path: dbPath });
      const queue1 = new TaskQueue(store1);

      const task = await queue1.enqueue({
        prompt: "retry-after-restart",
        conversationId: "conv-retry",
      });
      await queue1.dequeue("worker-1");

      store1.close();

      // Session 2: recover and retry
      const store2 = new SQLiteTaskStore({ path: dbPath });
      const queue2 = new TaskQueue(store2);

      await queue2.recoverFromRestart();

      const failed = await queue2.getTask(task.id);
      expect(failed?.status).toBe("failed");
      expect(failed?.error).toBe("daemon restart");

      // Retry creates a new pending task with the original prompt
      const retried = await queue2.retry(task.id);
      expect(retried).not.toBeNull();
      expect(retried?.status).toBe("pending");
      expect(retried?.prompt).toBe("retry-after-restart");
      expect(retried?.conversationId).toBe("conv-retry");
      expect(retried?.id).not.toBe(task.id);

      store2.close();
    });
  });

  test("task history persists across multiple restarts", async () => {
    await withTempDb(async (dbPath) => {
      // Session 1: create and complete a task
      const store1 = new SQLiteTaskStore({ path: dbPath });
      const queue1 = new TaskQueue(store1);

      await queue1.enqueue({ prompt: "history-task-1" });
      const task1 = (await queue1.list())[0];
      expect(task1).toBeDefined();
      await queue1.dequeue("w1");
      await queue1.complete(task1!.id, "Result 1");
      store1.close();

      // Session 2: add another task
      const store2 = new SQLiteTaskStore({ path: dbPath });
      const queue2 = new TaskQueue(store2);

      await queue2.enqueue({ prompt: "history-task-2" });
      const allTasks2 = await queue2.list();
      expect(allTasks2).toHaveLength(2);
      store2.close();

      // Session 3: verify full history
      const store3 = new SQLiteTaskStore({ path: dbPath });
      const queue3 = new TaskQueue(store3);

      const allTasks3 = await queue3.list();
      expect(allTasks3).toHaveLength(2);

      const prompts = allTasks3.map((t) => t.prompt).sort();
      expect(prompts).toEqual(["history-task-1", "history-task-2"]);

      const completedTask = allTasks3.find((t) => t.prompt === "history-task-1");
      expect(completedTask?.status).toBe("complete");
      expect(completedTask?.result).toBe("Result 1");

      store3.close();
    });
  });

  test("SQLite database uses WAL mode", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });

      // WAL mode is set during construction; verify by querying pragma
      const { Database } = await import("bun:sqlite");
      const db = new Database(dbPath, { readonly: true });
      const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
      expect(row?.journal_mode).toBe("wal");
      db.close();

      store.close();
    });
  });
});

// ---------------------------------------------------------------------------
// Delivery pipeline: routes to correct target
// ---------------------------------------------------------------------------

describe("Task delivery pipeline routing", () => {
  test("delivers to active TUI when websocket is connected", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport, sentMessages } = createWebSocketTransport(true);
      const { channel } = createMockChannel("alerts");
      channelRegistry.register(channel);

      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, {
        wsTransport: transport,
      });

      const task = await store.createTask({
        prompt: "TUI delivery test",
        conversationId: "conv-tui",
      });
      await markTaskComplete(store, task.id);

      const report = await pipeline.deliver(task.id, "TUI result content");

      expect(report.method).toBe("tui");
      expect(report.delivered).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.taskId).toBe(task.id);
      expect(sentMessages[0]?.conversationId).toBe("conv-tui");
      expect(sentMessages[0]?.content).toContain("TUI result content");

      const persisted = await store.getTask(task.id);
      expect(persisted?.delivered).toBe(true);

      store.close();
    });
  });

  test("falls back to channel when websocket is disconnected", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport, sentMessages: wsSent } = createWebSocketTransport(false);
      const { channel, sentMessages: channelSent } = createMockChannel("notifications");
      channelRegistry.register(channel);

      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, {
        wsTransport: transport,
      });

      const task = await store.createTask({ prompt: "Channel delivery test" });
      await markTaskComplete(store, task.id);

      const report = await pipeline.deliver(task.id, "Channel result content");

      expect(report.method).toBe("channel");
      expect(report.delivered).toBe(true);
      expect(report.channelSuccessCount).toBe(1);
      expect(report.channelFailureCount).toBe(0);
      expect(wsSent).toHaveLength(0);
      expect(channelSent).toHaveLength(1);
      expect(channelSent[0]?.text).toContain("Channel result content");

      store.close();
    });
  });

  test("falls back to badge when neither websocket nor channels are available", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport, sentMessages: wsSent } = createWebSocketTransport(false);

      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, {
        wsTransport: transport,
      });

      const task = await store.createTask({ prompt: "Badge delivery test" });
      await markTaskComplete(store, task.id);

      const report = await pipeline.deliver(task.id, "Badge result content");

      expect(report.method).toBe("badge");
      expect(report.delivered).toBe(false);
      expect(wsSent).toHaveLength(0);

      const persisted = await store.getTask(task.id);
      expect(persisted?.delivered).toBe(false);

      const badgeCount = await pipeline.getBadgeCount();
      expect(badgeCount).toBe(1);

      store.close();
    });
  });

  test("TUI takes priority over channels when both are available", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport, sentMessages: wsSent } = createWebSocketTransport(true);
      const { channel, sentMessages: channelSent } = createMockChannel("both-available");
      channelRegistry.register(channel);

      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, {
        wsTransport: transport,
      });

      const task = await store.createTask({ prompt: "Priority test" });
      await markTaskComplete(store, task.id);

      const report = await pipeline.deliver(task.id, "Priority result");

      // TUI should win when both are available
      expect(report.method).toBe("tui");
      expect(report.delivered).toBe(true);
      expect(wsSent).toHaveLength(1);
      expect(channelSent).toHaveLength(0);

      store.close();
    });
  });

  test("badge count accumulates for multiple undelivered tasks", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport } = createWebSocketTransport(false);

      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, {
        wsTransport: transport,
      });

      const task1 = await store.createTask({ prompt: "Badge task 1" });
      const task2 = await store.createTask({ prompt: "Badge task 2" });
      const task3 = await store.createTask({ prompt: "Badge task 3" });

      await markTaskComplete(store, task1.id);
      await markTaskComplete(store, task2.id);
      await markTaskComplete(store, task3.id);

      await pipeline.deliver(task1.id, "Result 1");
      await pipeline.deliver(task2.id, "Result 2");
      await pipeline.deliver(task3.id, "Result 3");

      const badgeCount = await pipeline.getBadgeCount();
      expect(badgeCount).toBe(3);

      store.close();
    });
  });

  test("delivery pipeline handles channel failure gracefully", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport } = createWebSocketTransport(false);

      // Create a channel that always fails
      const failingChannel: Channel = {
        config: {
          id: "failing-channel",
          platform: "telegram",
          tokenReference: "token-fail",
          enabled: true,
        },
        status: { state: "connected", uptimeMs: 1000 },
        async connect() { /* no-op */ },
        async disconnect() { /* no-op */ },
        async send() {
          throw new Error("Channel send failed");
        },
        onMessage() {
          return () => { /* no-op */ };
        },
      };
      channelRegistry.register(failingChannel);

      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, {
        wsTransport: transport,
      });

      const task = await store.createTask({ prompt: "Failing channel test" });
      await markTaskComplete(store, task.id);

      const report = await pipeline.deliver(task.id, "Result for failing channel");

      // All channels failed, so falls back to badge
      expect(report.method).toBe("badge");
      expect(report.delivered).toBe(false);
      expect(report.channelSuccessCount).toBe(0);
      expect(report.channelFailureCount).toBe(1);

      store.close();
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: Worker + Queue + Delivery integration
// ---------------------------------------------------------------------------

describe("End-to-end task lifecycle", () => {
  test("enqueue → worker execution → completion → delivery pipeline", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const queue = new TaskQueue(store);
      const providerRegistry = new ProviderRegistry();
      const permissionChecker = new PermissionChecker(FULL_PROFILE);
      const channelRegistry = new ChannelRegistry();
      const { transport, sentMessages } = createWebSocketTransport(true);

      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, {
        wsTransport: transport,
      });

      // Enqueue a task
      const task = await queue.enqueue({
        prompt: "Summarize meeting notes",
        conversationId: "conv-e2e",
      });
      expect(task.status).toBe("pending");

      // Worker picks up and completes the task
      const manager = new WorkerManager(queue, providerRegistry, permissionChecker, {
        runTask: async () => "Meeting notes summarized successfully",
      });

      await manager.spawn(task.id);

      await waitFor(async () => {
        const completed = await queue.getTask(task.id);
        return completed?.status === "complete";
      });

      // Wait for worker to fully complete (including finally block)
      await waitFor(() => manager.getStatus().runningCount === 0);

      // Deliver the result
      const completedTask = await queue.getTask(task.id);
      expect(completedTask?.status).toBe("complete");
      expect(completedTask?.result).toBe("Meeting notes summarized successfully");

      const report = await pipeline.deliver(
        task.id,
        completedTask?.result ?? "",
      );

      expect(report.method).toBe("tui");
      expect(report.delivered).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.content).toContain("Meeting notes summarized successfully");

      store.close();
    });
  });

  test("worker failure → recovery on restart → retry → successful completion", async () => {
    await withTempDb(async (dbPath) => {
      // Session 1: worker starts but "crashes" (simulated by shutdown)
      const store1 = new SQLiteTaskStore({ path: dbPath });
      const queue1 = new TaskQueue(store1);
      const providerRegistry = new ProviderRegistry();
      const permissionChecker = new PermissionChecker(FULL_PROFILE);

      const task = await queue1.enqueue({ prompt: "crash-and-retry task" });

      const workerStarted = createDeferred<void>();

      const manager = new WorkerManager(queue1, providerRegistry, permissionChecker, {
        runTask: async (context: WorkerRunContext) => {
          workerStarted.resolve();
          // Simulate long-running work that will be interrupted by shutdown
          await new Promise<string>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("simulated crash")), 5_000);
            context.abortSignal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(new Error("aborted"));
            }, { once: true });
          });
          return "never reached";
        },
      });

      await manager.spawn(task.id);
      await workerStarted.promise;

      // Verify task is running
      const runningTask = await queue1.getTask(task.id);
      expect(runningTask?.status).toBe("running");

      // Shut down the worker manager before closing the database to avoid
      // the race condition where executeWorker tries to update a closed db
      await manager.shutdown();

      store1.close();

      // Session 2: recover and retry
      const store2 = new SQLiteTaskStore({ path: dbPath });
      const queue2 = new TaskQueue(store2);

      // Shutdown already cancelled the worker (marking it failed with "cancelled"),
      // so recoverFromRestart finds no running tasks to recover
      const recoveredCount = await queue2.recoverFromRestart();
      expect(recoveredCount).toBe(0);

      const failedTask = await queue2.getTask(task.id);
      expect(failedTask?.status).toBe("failed");
      expect(failedTask?.error).toBe("cancelled");

      // Retry the failed task
      const retriedTask = await queue2.retry(task.id);
      expect(retriedTask).not.toBeNull();
      expect(retriedTask?.status).toBe("pending");
      expect(retriedTask?.prompt).toBe("crash-and-retry task");

      // Complete the retried task successfully
      const manager2 = new WorkerManager(queue2, providerRegistry, permissionChecker, {
        runTask: async () => "Successfully completed on retry",
      });

      await manager2.spawn(retriedTask!.id);

      await waitFor(async () => {
        const completed = await queue2.getTask(retriedTask!.id);
        return completed?.status === "complete";
      });

      // Wait for worker to fully complete (including finally block)
      await waitFor(() => manager2.getStatus().runningCount === 0);

      const completedRetry = await queue2.getTask(retriedTask!.id);
      expect(completedRetry?.status).toBe("complete");
      expect(completedRetry?.result).toBe("Successfully completed on retry");

      store2.close();
    });
  });
});
