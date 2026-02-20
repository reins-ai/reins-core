import { describe, expect, it } from "bun:test";

import { TelegramChannel } from "../../../src/channels/telegram/channel";
import type { TelegramChannelClient } from "../../../src/channels/telegram/channel";
import { formatForTelegram } from "../../../src/channels/formatting";
import { ChannelRouter, type AgentResponse } from "../../../src/channels/router";
import type { ChannelRouterConversationManager } from "../../../src/channels/router";
import type { ChannelMessage } from "../../../src/channels/types";
import type { TelegramUpdate } from "../../../src/channels/telegram/types";
import { ChannelError } from "../../../src/channels/errors";

// ---------------------------------------------------------------------------
// Shared test utilities
// ---------------------------------------------------------------------------

interface ScheduledTask {
  id: number;
  delayMs: number;
  callback: () => void;
  cleared: boolean;
}

class PollScheduler {
  private tasks: ScheduledTask[] = [];
  private nextId = 1;

  public schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const task: ScheduledTask = {
      id: this.nextId,
      delayMs,
      callback,
      cleared: false,
    };
    this.nextId += 1;
    this.tasks.push(task);
    return task.id as ReturnType<typeof setTimeout>;
  };

  public clear = (timer: ReturnType<typeof setTimeout>): void => {
    const numericTimer = timer as unknown as number;
    const task = this.tasks.find((entry) => entry.id === numericTimer);
    if (task !== undefined) {
      task.cleared = true;
    }
  };

  public async flush(limit = 10): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      const task = this.tasks.shift();
      if (task === undefined) {
        return;
      }

      if (task.cleared) {
        continue;
      }

      task.callback();
      // Flush enough microtasks for deeply async handler chains
      // (poll → getUpdates → dispatchUpdates → handler → router → conversationManager)
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }
    }
  }
}

class MockTelegramClient implements TelegramChannelClient {
  public getMeCalls = 0;
  public sendMessageCalls: Array<{ chatId: string | number; text: string }> = [];
  public sendPhotoCalls: Array<{ chatId: string | number; photo: string; options?: Record<string, unknown> }> = [];
  public sendVoiceCalls: Array<{ chatId: string | number; voice: string }> = [];

  private readonly updatesQueue: Array<TelegramUpdate[] | Error>;
  private readonly getMeError: Error | null;

  constructor(options: { updatesQueue?: Array<TelegramUpdate[] | Error>; getMeError?: Error } = {}) {
    this.updatesQueue = options.updatesQueue ?? [];
    this.getMeError = options.getMeError ?? null;
  }

  public async getMe(): Promise<unknown> {
    this.getMeCalls += 1;
    if (this.getMeError !== null) {
      throw this.getMeError;
    }
    return { id: 10, is_bot: true };
  }

  public async getUpdates(): Promise<TelegramUpdate[]> {
    const next = this.updatesQueue.shift();
    if (next === undefined) {
      return [];
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  public async sendMessage(chatId: string | number, text: string): Promise<unknown> {
    this.sendMessageCalls.push({ chatId, text });
    return {};
  }

  public async sendPhoto(chatId: string | number, photo: string, options?: Record<string, unknown>): Promise<unknown> {
    this.sendPhotoCalls.push({ chatId, photo, options });
    return {};
  }

  public async sendDocument(): Promise<unknown> {
    return {};
  }

  public async sendVoice(chatId: string | number, voice: string): Promise<unknown> {
    this.sendVoiceCalls.push({ chatId, voice });
    return {};
  }
}

interface MockConversationManager {
  manager: ChannelRouterConversationManager;
  createdConversations: Array<{ id: string; title?: string }>;
  addedMessages: Array<{
    conversationId: string;
    message: {
      role: "user" | "assistant" | "system" | "tool";
      content: string;
      metadata?: Record<string, unknown>;
    };
  }>;
}

function createMockConversationManager(): MockConversationManager {
  const createdConversations: MockConversationManager["createdConversations"] = [];
  const addedMessages: MockConversationManager["addedMessages"] = [];
  let conversationCounter = 0;
  let messageCounter = 0;

  return {
    manager: {
      async create(options) {
        conversationCounter += 1;
        const id = `conv-${conversationCounter}`;
        createdConversations.push({ id, title: options.title });
        return { id };
      },
      async addMessage(conversationId, message) {
        messageCounter += 1;
        addedMessages.push({ conversationId, message });
        return { id: `msg-${messageCounter}` };
      },
    },
    createdConversations,
    addedMessages,
  };
}

function makeTextUpdate(text: string, chatId = 12345, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Alice" },
      from: { id: 42, is_bot: false, first_name: "Alice", username: "alice" },
      text,
    },
  };
}

function makePhotoUpdate(chatId = 12345, updateId = 2): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Alice" },
      from: { id: 42, is_bot: false, first_name: "Alice", username: "alice" },
      caption: "Check this out",
      photo: [
        { file_id: "small_id", file_unique_id: "small_uid", width: 90, height: 90 },
        { file_id: "large_id", file_unique_id: "large_uid", width: 800, height: 600, file_size: 50000 },
      ],
    },
  };
}

function makeVoiceUpdate(chatId = 12345, updateId = 3): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Alice" },
      from: { id: 42, is_bot: false, first_name: "Alice", username: "alice" },
      voice: {
        file_id: "voice_file_id",
        file_unique_id: "voice_uid",
        duration: 5,
        mime_type: "audio/ogg",
        file_size: 12000,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Telegram E2E Flow", () => {
  describe("text message round-trip", () => {
    it("receives a text message, routes to conversation, and sends agent response back", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient({
        updatesQueue: [
          [makeTextUpdate("Hello bot", 12345, 100)],
        ],
      });
      const { manager, createdConversations, addedMessages } = createMockConversationManager();

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      const router = new ChannelRouter({
        conversationManager: manager,
        nowFn: () => new Date("2026-02-15T10:00:00.000Z"),
      });

      const receivedMessages: ChannelMessage[] = [];
      channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
        const result = await router.routeInbound(msg, channel);

        const agentResponse: AgentResponse = {
          conversationId: result.conversationId,
          text: "Hello from Reins!",
          assistantMessageId: result.assistantMessageId,
        };
        await router.routeOutbound(agentResponse, channel);
      });

      await channel.connect();
      expect(channel.status.state).toBe("connected");

      // Flush the poll scheduler to process updates
      await scheduler.flush(1);

      // Verify message was received and normalized
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]!.platform).toBe("telegram");
      expect(receivedMessages[0]!.text).toBe("Hello bot");
      expect(receivedMessages[0]!.sender.username).toBe("alice");

      // Verify conversation was created and messages added
      expect(createdConversations).toHaveLength(1);
      expect(addedMessages).toHaveLength(2);
      expect(addedMessages[0]!.message.role).toBe("user");
      expect(addedMessages[0]!.message.content).toBe("Hello bot");
      expect(addedMessages[1]!.message.role).toBe("assistant");

      // Verify agent response was sent back to Telegram (formatted as MarkdownV2)
      expect(client.sendMessageCalls).toHaveLength(1);
      expect(client.sendMessageCalls[0]!.chatId).toBe(12345);
      expect(client.sendMessageCalls[0]!.text).toBe(formatForTelegram("Hello from Reins!"));

      await channel.disconnect();
      expect(channel.status.state).toBe("disconnected");
    });

    it("preserves conversation context across multiple messages", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient({
        updatesQueue: [
          [makeTextUpdate("First message", 12345, 100)],
          [makeTextUpdate("Second message", 12345, 101)],
        ],
      });
      const { manager, createdConversations, addedMessages } = createMockConversationManager();

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      const router = new ChannelRouter({ conversationManager: manager });

      let lastConversationId: string | undefined;
      channel.onMessage(async (msg) => {
        const messageWithConversation = lastConversationId
          ? { ...msg, conversationId: lastConversationId }
          : msg;
        const result = await router.routeInbound(messageWithConversation, channel);
        lastConversationId = result.conversationId;
      });

      await channel.connect();

      // First poll — creates conversation
      await scheduler.flush(1);
      expect(createdConversations).toHaveLength(1);
      expect(addedMessages).toHaveLength(2);

      // Second poll — reuses conversation
      await scheduler.flush(1);
      expect(createdConversations).toHaveLength(1);
      expect(addedMessages).toHaveLength(4);
      expect(addedMessages[2]!.conversationId).toBe(addedMessages[0]!.conversationId);

      await channel.disconnect();
    });
  });

  describe("attachment message flow", () => {
    it("receives a photo message and routes it with attachment metadata", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient({
        updatesQueue: [
          [makePhotoUpdate(12345, 200)],
        ],
      });
      const { manager, addedMessages } = createMockConversationManager();

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      const router = new ChannelRouter({ conversationManager: manager });

      const receivedMessages: ChannelMessage[] = [];
      channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
        await router.routeInbound(msg, channel);
      });

      await channel.connect();
      await scheduler.flush(1);

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0]!;
      expect(msg.text).toBe("Check this out");
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0]!.type).toBe("image");
      expect(msg.attachments![0]!.platformData?.file_id).toBe("large_id");

      // Caption is used as conversation content
      expect(addedMessages[0]!.message.content).toBe("Check this out");

      await channel.disconnect();
    });
  });

  describe("voice message flow", () => {
    it("receives a voice message and normalizes voice metadata", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient({
        updatesQueue: [
          [makeVoiceUpdate(12345, 300)],
        ],
      });

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      const receivedMessages: ChannelMessage[] = [];
      channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      await channel.connect();
      await scheduler.flush(1);

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0]!;
      expect(msg.voice).toBeDefined();
      expect(msg.voice!.mimeType).toBe("audio/ogg");
      expect(msg.voice!.durationMs).toBe(5000);
      expect(msg.voice!.platformData?.file_id).toBe("voice_file_id");

      await channel.disconnect();
    });
  });

  describe("error handling", () => {
    it("throws ChannelError when connecting with invalid token", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient({
        getMeError: new Error("401 Unauthorized"),
      });

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      await expect(channel.connect()).rejects.toThrow(ChannelError);
      expect(channel.status.state).toBe("error");
      expect(channel.status.lastError).toContain("401 Unauthorized");
    });

    it("transitions to reconnecting state on poll failure", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient({
        updatesQueue: [
          new Error("Network timeout"),
        ],
      });

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      await channel.connect();
      expect(channel.status.state).toBe("connected");

      await scheduler.flush(1);
      expect(channel.status.state).toBe("reconnecting");
      expect(channel.status.lastError).toContain("Network timeout");

      await channel.disconnect();
    });

    it("recovers from poll failure when next poll succeeds", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient({
        updatesQueue: [
          new Error("Temporary failure"),
          [], // success on retry
        ],
      });

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      await channel.connect();

      // First poll fails
      await scheduler.flush(1);
      expect(channel.status.state).toBe("reconnecting");

      // Second poll succeeds (reconnect scheduled)
      await scheduler.flush(1);
      expect(channel.status.state).toBe("connected");

      await channel.disconnect();
    });

    it("rejects send when channel is disconnected", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient();

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      const message: ChannelMessage = {
        id: "out-1",
        platform: "telegram",
        channelId: "12345",
        sender: { id: "reins-agent", isBot: true },
        timestamp: new Date(),
        text: "Hello",
      };

      await expect(channel.send(message)).rejects.toThrow(ChannelError);
    });

    it("handles message handler errors without crashing the poll loop", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient({
        updatesQueue: [
          [makeTextUpdate("test", 12345, 400)],
          [], // second poll to verify loop continues
        ],
      });

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      // Register a handler that throws
      channel.onMessage(async () => {
        throw new Error("Handler exploded");
      });

      // Register a second handler that should still run
      const receivedMessages: ChannelMessage[] = [];
      channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      await channel.connect();
      await scheduler.flush(1);

      // Second handler still received the message
      expect(receivedMessages).toHaveLength(1);
      // Channel is still connected (poll loop didn't crash)
      expect(channel.status.state).toBe("connected");

      await channel.disconnect();
    });
  });

  describe("send message types", () => {
    it("sends text response back to the correct chat", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient();

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      await channel.connect();

      const outbound: ChannelMessage = {
        id: "out-1",
        platform: "telegram",
        channelId: "67890",
        sender: { id: "reins-agent", isBot: true },
        timestamp: new Date(),
        text: "Agent response",
        platformData: { chat_id: 67890 },
      };

      await channel.send(outbound);

      expect(client.sendMessageCalls).toHaveLength(1);
      expect(client.sendMessageCalls[0]!.chatId).toBe(67890);
      expect(client.sendMessageCalls[0]!.text).toBe("Agent response");

      await channel.disconnect();
    });

    it("sends attachment response via sendPhoto for image type", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient();

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      await channel.connect();

      const outbound: ChannelMessage = {
        id: "out-2",
        platform: "telegram",
        channelId: "67890",
        sender: { id: "reins-agent", isBot: true },
        timestamp: new Date(),
        text: "Here is the image",
        attachments: [
          {
            type: "image",
            url: "https://example.com/photo.jpg",
            platformData: { file_id: "photo_file_id" },
          },
        ],
        platformData: { chat_id: 67890 },
      };

      await channel.send(outbound);

      expect(client.sendPhotoCalls).toHaveLength(1);
      expect(client.sendPhotoCalls[0]!.chatId).toBe(67890);

      await channel.disconnect();
    });

    it("sends voice response via sendVoice", async () => {
      const scheduler = new PollScheduler();
      const client = new MockTelegramClient();

      const channel = new TelegramChannel({
        config: { id: "telegram-main", platform: "telegram", tokenReference: "ref", enabled: true },
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
      });

      await channel.connect();

      const outbound: ChannelMessage = {
        id: "out-3",
        platform: "telegram",
        channelId: "67890",
        sender: { id: "reins-agent", isBot: true },
        timestamp: new Date(),
        voice: {
          platformData: { file_id: "voice_out_id" },
        },
        platformData: { chat_id: 67890 },
      };

      await channel.send(outbound);

      expect(client.sendVoiceCalls).toHaveLength(1);
      expect(client.sendVoiceCalls[0]!.chatId).toBe(67890);

      await channel.disconnect();
    });
  });
});
