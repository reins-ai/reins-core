import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelRegistry } from "../../src/channels/registry";
import { TaskDeliveryPipeline, type TaskDeliveryWebSocketTransport } from "../../src/tasks/delivery-pipeline";
import { SQLiteTaskStore } from "../../src/tasks/task-store";
import type { Channel, ChannelMessage } from "../../src/channels/types";

async function withTempDb(run: (dbPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "reins-task-delivery-"));
  const dbPath = join(directory, "tasks.db");

  try {
    await run(dbPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

interface MockChannel {
  channel: Channel;
  sentMessages: ChannelMessage[];
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

function createMockChannel(id: string): MockChannel {
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

describe("TaskDeliveryPipeline", () => {
  test("delivers to active TUI websocket and marks task delivered", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport, sentMessages } = createWebSocketTransport(true);
      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, { wsTransport: transport });

      const task = await store.createTask({
        prompt: "Summarize sprint updates",
        conversationId: "conv-123",
      });
      await markTaskComplete(store, task.id);

      const report = await pipeline.deliver(task.id, "All sprint updates are complete.");

      expect(report.method).toBe("tui");
      expect(report.delivered).toBe(true);
      expect(sentMessages).toHaveLength(1);
      expect(sentMessages[0]?.taskId).toBe(task.id);
      expect(sentMessages[0]?.conversationId).toBe("conv-123");
      expect(sentMessages[0]?.content).toContain("Background task complete:");

      const persisted = await store.getTask(task.id);
      expect(persisted?.delivered).toBe(true);
      expect(await pipeline.getBadgeCount()).toBe(0);

      store.close();
    });
  });

  test("falls back to channel delivery when websocket is not connected", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport, sentMessages } = createWebSocketTransport(false);
      const { channel, sentMessages: channelMessages } = createMockChannel("alerts");
      channelRegistry.register(channel);

      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, { wsTransport: transport });
      const task = await store.createTask({ prompt: "Generate weekly digest" });
      await markTaskComplete(store, task.id);

      const report = await pipeline.deliver(task.id, "Weekly digest generated.");

      expect(report.method).toBe("channel");
      expect(report.delivered).toBe(true);
      expect(report.channelSuccessCount).toBe(1);
      expect(report.channelFailureCount).toBe(0);
      expect(sentMessages).toHaveLength(0);
      expect(channelMessages).toHaveLength(1);
      expect(channelMessages[0]?.channelId).toBe("alerts");
      expect(channelMessages[0]?.text).toContain("Weekly digest generated.");

      const persisted = await store.getTask(task.id);
      expect(persisted?.delivered).toBe(true);
      expect(await pipeline.getBadgeCount()).toBe(0);

      store.close();
    });
  });

  test("queues for badge when neither websocket nor channels are available", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport, sentMessages } = createWebSocketTransport(false);
      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, { wsTransport: transport });

      const task = await store.createTask({ prompt: "Compile research notes" });
      await markTaskComplete(store, task.id);

      const report = await pipeline.deliver(task.id, "Research notes are compiled.");

      expect(report.method).toBe("badge");
      expect(report.delivered).toBe(false);
      expect(sentMessages).toHaveLength(0);

      const persisted = await store.getTask(task.id);
      expect(persisted?.delivered).toBe(false);
      expect(await pipeline.getBadgeCount()).toBe(1);

      store.close();
    });
  });

  test("uses fallback chain websocket -> channel -> badge", async () => {
    await withTempDb(async (dbPath) => {
      const store = new SQLiteTaskStore({ path: dbPath });
      const channelRegistry = new ChannelRegistry();
      const { transport, sentMessages } = createWebSocketTransport(false);
      const { channel, sentMessages: channelMessages } = createMockChannel("fallback");
      channelRegistry.register(channel);

      const pipeline = new TaskDeliveryPipeline(store, channelRegistry, { wsTransport: transport });

      const channelTask = await store.createTask({ prompt: "Channel fallback task" });
      await markTaskComplete(store, channelTask.id);
      const channelReport = await pipeline.deliver(channelTask.id, "Channel fallback used.");

      channelRegistry.clear();

      const badgeTask = await store.createTask({ prompt: "Badge fallback task" });
      await markTaskComplete(store, badgeTask.id);
      const badgeReport = await pipeline.deliver(badgeTask.id, "Badge fallback used.");

      expect(sentMessages).toHaveLength(0);
      expect(channelMessages).toHaveLength(1);
      expect(channelReport.method).toBe("channel");
      expect(badgeReport.method).toBe("badge");
      expect(await pipeline.getBadgeCount()).toBe(1);

      store.close();
    });
  });
});
