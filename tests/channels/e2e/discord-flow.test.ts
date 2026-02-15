import { describe, expect, it } from "bun:test";

import { DiscordChannel } from "../../../src/channels/discord/channel";
import type { DiscordChannelOptions } from "../../../src/channels/discord/channel";
import { ChannelRouter, type AgentResponse } from "../../../src/channels/router";
import type { ChannelRouterConversationManager } from "../../../src/channels/router";
import type { ChannelMessage } from "../../../src/channels/types";
import type { DiscordEmbed, DiscordMessage, DiscordUser } from "../../../src/channels/discord/types";
import { ChannelError } from "../../../src/channels/errors";

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

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

function createMockDiscordClient(): {
  getCurrentUser: () => Promise<DiscordUser>;
  sendMessage: (channelId: string, content: string) => Promise<unknown>;
  sendEmbed: (channelId: string, embed: DiscordEmbed) => Promise<unknown>;
  uploadFile: (channelId: string, file: { name: string; data: string; description?: string }) => Promise<unknown>;
  sentMessages: Array<{ channelId: string; content: string }>;
  sentEmbeds: Array<{ channelId: string; embed: DiscordEmbed }>;
  sentFiles: Array<{ channelId: string; file: { name: string; data: string } }>;
} {
  const sentMessages: Array<{ channelId: string; content: string }> = [];
  const sentEmbeds: Array<{ channelId: string; embed: DiscordEmbed }> = [];
  const sentFiles: Array<{ channelId: string; file: { name: string; data: string } }> = [];

  return {
    async getCurrentUser() {
      return {
        id: "bot-123",
        username: "ReinsBot",
        discriminator: "0001",
        global_name: "Reins Bot",
        bot: true,
      };
    },
    async sendMessage(channelId, content) {
      sentMessages.push({ channelId, content });
      return { id: "sent-msg-1" };
    },
    async sendEmbed(channelId, embed) {
      sentEmbeds.push({ channelId, embed });
      return { id: "sent-embed-1" };
    },
    async uploadFile(channelId, file) {
      sentFiles.push({ channelId, file: { name: file.name, data: file.data } });
      return { id: "sent-file-1" };
    },
    sentMessages,
    sentEmbeds,
    sentFiles,
  };
}

interface MockGatewayHandlers {
  readyHandlers: Array<(event: { session_id: string; resume_gateway_url?: string }) => Promise<void> | void>;
  messageHandlers: Array<(message: DiscordMessage) => Promise<void> | void>;
  disconnectHandlers: Array<(details: { code?: number; reason?: string; error?: string }) => Promise<void> | void>;
}

function createMockGateway(): {
  gateway: NonNullable<DiscordChannelOptions["gateway"]>;
  handlers: MockGatewayHandlers;
  simulateReady: (sessionId?: string) => Promise<void>;
  simulateMessage: (message: DiscordMessage) => Promise<void>;
  simulateDisconnect: (details?: { code?: number; reason?: string; error?: string }) => Promise<void>;
} {
  const handlers: MockGatewayHandlers = {
    readyHandlers: [],
    messageHandlers: [],
    disconnectHandlers: [],
  };

  let sequence: number | null = null;

  const gateway: NonNullable<DiscordChannelOptions["gateway"]> = {
    get connected() { return true; },
    get currentSequence() { return sequence; },
    async connect() {},
    async disconnect() {},
    onReady(handler) {
      handlers.readyHandlers.push(handler);
      return () => {
        const idx = handlers.readyHandlers.indexOf(handler);
        if (idx >= 0) handlers.readyHandlers.splice(idx, 1);
      };
    },
    onMessageCreate(handler) {
      handlers.messageHandlers.push(handler);
      return () => {
        const idx = handlers.messageHandlers.indexOf(handler);
        if (idx >= 0) handlers.messageHandlers.splice(idx, 1);
      };
    },
    onDisconnect(handler) {
      handlers.disconnectHandlers.push(handler);
      return () => {
        const idx = handlers.disconnectHandlers.indexOf(handler);
        if (idx >= 0) handlers.disconnectHandlers.splice(idx, 1);
      };
    },
    prepareResume() {},
  };

  async function simulateReady(sessionId = "session-abc") {
    for (const handler of handlers.readyHandlers) {
      await handler({ session_id: sessionId, resume_gateway_url: "wss://resume.discord.gg" });
    }
  }

  async function simulateMessage(message: DiscordMessage) {
    sequence = (sequence ?? 0) + 1;
    for (const handler of handlers.messageHandlers) {
      await handler(message);
    }
  }

  async function simulateDisconnect(details: { code?: number; reason?: string; error?: string } = {}) {
    for (const handler of handlers.disconnectHandlers) {
      await handler(details);
    }
  }

  return { gateway, handlers, simulateReady, simulateMessage, simulateDisconnect };
}

function makeTextMessage(
  content: string,
  channelId = "dc-channel-1",
  messageId = "dc-msg-1",
): DiscordMessage {
  return {
    id: messageId,
    channel_id: channelId,
    author: {
      id: "user-42",
      username: "alice",
      discriminator: "1234",
      global_name: "Alice",
      bot: false,
    },
    content,
    timestamp: new Date().toISOString(),
    embeds: [],
    attachments: [],
  };
}

function makeAttachmentMessage(
  channelId = "dc-channel-1",
  messageId = "dc-msg-2",
): DiscordMessage {
  return {
    id: messageId,
    channel_id: channelId,
    author: {
      id: "user-42",
      username: "alice",
      discriminator: "1234",
      global_name: "Alice",
    },
    content: "Check this image",
    timestamp: new Date().toISOString(),
    embeds: [],
    attachments: [
      {
        id: "att-1",
        filename: "photo.png",
        size: 50000,
        url: "https://cdn.discord.com/attachments/photo.png",
        proxy_url: "https://media.discord.com/attachments/photo.png",
        content_type: "image/png",
      },
    ],
  };
}

function makeVoiceMessage(
  channelId = "dc-channel-1",
  messageId = "dc-msg-3",
): DiscordMessage {
  return {
    id: messageId,
    channel_id: channelId,
    author: {
      id: "user-42",
      username: "alice",
      discriminator: "1234",
      global_name: "Alice",
    },
    content: "",
    timestamp: new Date().toISOString(),
    embeds: [],
    attachments: [
      {
        id: "att-voice-1",
        filename: "voice.webm",
        size: 15000,
        url: "https://cdn.discord.com/attachments/voice.webm",
        proxy_url: "https://media.discord.com/attachments/voice.webm",
        content_type: "audio/webm",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Discord E2E Flow", () => {
  describe("text message round-trip", () => {
    it("receives a text message via gateway, routes to conversation, and sends response back", async () => {
      const client = createMockDiscordClient();
      const mock = createMockGateway();
      const { manager, createdConversations, addedMessages } = createMockConversationManager();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      const router = new ChannelRouter({
        conversationManager: manager,
        nowFn: () => new Date("2026-02-15T10:00:00.000Z"),
      });

      const receivedMessages: ChannelMessage[] = [];
      channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
        const result = await router.routeInbound(msg, channel);

        // Agent response includes channel_id in metadata so Discord send can resolve the target
        const agentResponse: AgentResponse = {
          conversationId: result.conversationId,
          text: "Hello from Reins!",
          assistantMessageId: result.assistantMessageId,
          metadata: { channel_id: msg.platformData?.channel_id },
        };
        await router.routeOutbound(agentResponse, channel);
      });

      await channel.connect();
      await mock.simulateReady();
      expect(channel.status.state).toBe("connected");

      await mock.simulateMessage(makeTextMessage("Hello Discord bot", "dc-channel-1", "dc-msg-100"));

      // Verify message was received and normalized
      expect(receivedMessages).toHaveLength(1);
      expect(receivedMessages[0]!.platform).toBe("discord");
      expect(receivedMessages[0]!.text).toBe("Hello Discord bot");
      expect(receivedMessages[0]!.sender.username).toBe("alice");
      expect(receivedMessages[0]!.channelId).toBe("dc-channel-1");

      // Verify conversation was created
      expect(createdConversations).toHaveLength(1);
      expect(addedMessages).toHaveLength(2);
      expect(addedMessages[0]!.message.role).toBe("user");
      expect(addedMessages[0]!.message.content).toBe("Hello Discord bot");

      // Verify response was sent back via Discord REST
      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]!.channelId).toBe("dc-channel-1");
      expect(client.sentMessages[0]!.content).toBe("Hello from Reins!");

      await channel.disconnect();
      expect(channel.status.state).toBe("disconnected");
    });

    it("preserves conversation context across multiple messages", async () => {
      const client = createMockDiscordClient();
      const mock = createMockGateway();
      const { manager, createdConversations, addedMessages } = createMockConversationManager();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
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
      await mock.simulateReady();

      await mock.simulateMessage(makeTextMessage("First message", "dc-channel-1", "dc-msg-1"));
      expect(createdConversations).toHaveLength(1);

      await mock.simulateMessage(makeTextMessage("Second message", "dc-channel-1", "dc-msg-2"));
      // Reuses existing conversation
      expect(createdConversations).toHaveLength(1);
      expect(addedMessages).toHaveLength(4);
      expect(addedMessages[2]!.conversationId).toBe(addedMessages[0]!.conversationId);

      await channel.disconnect();
    });
  });

  describe("attachment message flow", () => {
    it("receives an image attachment and normalizes it", async () => {
      const client = createMockDiscordClient();
      const mock = createMockGateway();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      const receivedMessages: ChannelMessage[] = [];
      channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      await channel.connect();
      await mock.simulateReady();

      await mock.simulateMessage(makeAttachmentMessage("dc-channel-1", "dc-msg-att"));

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0]!;
      expect(msg.text).toBe("Check this image");
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments![0]!.type).toBe("image");
      expect(msg.attachments![0]!.mimeType).toBe("image/png");
      expect(msg.attachments![0]!.url).toBe("https://cdn.discord.com/attachments/photo.png");

      await channel.disconnect();
    });
  });

  describe("voice message flow", () => {
    it("receives a voice attachment and normalizes voice metadata", async () => {
      const client = createMockDiscordClient();
      const mock = createMockGateway();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      const receivedMessages: ChannelMessage[] = [];
      channel.onMessage(async (msg) => {
        receivedMessages.push(msg);
      });

      await channel.connect();
      await mock.simulateReady();

      await mock.simulateMessage(makeVoiceMessage("dc-channel-1", "dc-msg-voice"));

      expect(receivedMessages).toHaveLength(1);
      const msg = receivedMessages[0]!;
      expect(msg.voice).toBeDefined();
      expect(msg.voice!.mimeType).toBe("audio/webm");
      expect(msg.voice!.url).toBe("https://cdn.discord.com/attachments/voice.webm");

      await channel.disconnect();
    });
  });

  describe("error handling", () => {
    it("throws ChannelError when connecting with invalid token", async () => {
      const client = createMockDiscordClient();
      client.getCurrentUser = async () => {
        throw new Error("401: Unauthorized");
      };

      const mock = createMockGateway();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "invalid-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      await expect(channel.connect()).rejects.toThrow(ChannelError);
      expect(channel.status.state).toBe("error");
      expect(channel.status.lastError).toContain("401");
    });

    it("rejects empty token at construction time", () => {
      const client = createMockDiscordClient();

      expect(() => {
        new DiscordChannel({
          config: { id: "dc-1", platform: "discord", tokenReference: "ref", enabled: true },
          token: "   ",
          client,
          scheduleReconnectFn: (cb) => setTimeout(cb, 0),
          clearReconnectFn: (t) => clearTimeout(t),
        });
      }).toThrow(ChannelError);
    });

    it("transitions to reconnecting state on gateway disconnect", async () => {
      const client = createMockDiscordClient();
      const mock = createMockGateway();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: () => {},
      });

      await channel.connect();
      await mock.simulateReady();
      expect(channel.status.state).toBe("connected");

      await mock.simulateDisconnect({ reason: "Gateway closed" });
      expect(channel.status.state).toBe("reconnecting");
      expect(channel.status.lastError).toContain("Gateway closed");

      await channel.disconnect();
    });

    it("rejects send when channel is not connected", async () => {
      const client = createMockDiscordClient();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      const message: ChannelMessage = {
        id: "out-1",
        platform: "discord",
        channelId: "dc-channel-1",
        sender: { id: "reins-agent", isBot: true },
        timestamp: new Date(),
        text: "Hello",
        platformData: { channel_id: "dc-channel-1" },
      };

      await expect(channel.send(message)).rejects.toThrow(ChannelError);
    });

    it("handles message handler errors without crashing the gateway listener", async () => {
      const client = createMockDiscordClient();
      const mock = createMockGateway();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
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
      await mock.simulateReady();

      await mock.simulateMessage(makeTextMessage("test", "dc-channel-1", "dc-msg-err"));

      // Second handler still received the message
      expect(receivedMessages).toHaveLength(1);
      expect(channel.status.state).toBe("connected");

      await channel.disconnect();
    });
  });

  describe("send message types", () => {
    it("sends text response back to the correct Discord channel", async () => {
      const client = createMockDiscordClient();
      const mock = createMockGateway();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      await channel.connect();
      await mock.simulateReady();

      const outbound: ChannelMessage = {
        id: "out-1",
        platform: "discord",
        channelId: "dc-channel-1",
        sender: { id: "reins-agent", isBot: true },
        timestamp: new Date(),
        text: "Agent response",
        platformData: { channel_id: "dc-channel-1" },
      };

      await channel.send(outbound);

      expect(client.sentMessages).toHaveLength(1);
      expect(client.sentMessages[0]!.channelId).toBe("dc-channel-1");
      expect(client.sentMessages[0]!.content).toBe("Agent response");

      await channel.disconnect();
    });

    it("sends embed response when send_as_embed flag is set", async () => {
      const client = createMockDiscordClient();
      const mock = createMockGateway();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      await channel.connect();
      await mock.simulateReady();

      const outbound: ChannelMessage = {
        id: "out-embed",
        platform: "discord",
        channelId: "dc-channel-1",
        sender: { id: "reins-agent", isBot: true },
        timestamp: new Date(),
        text: "Rich response content",
        platformData: { channel_id: "dc-channel-1", send_as_embed: true },
      };

      await channel.send(outbound);

      expect(client.sentEmbeds).toHaveLength(1);
      expect(client.sentEmbeds[0]!.channelId).toBe("dc-channel-1");
      expect(client.sentEmbeds[0]!.embed.description).toBe("Rich response content");

      await channel.disconnect();
    });

    it("sends file upload for voice messages", async () => {
      const client = createMockDiscordClient();
      const mock = createMockGateway();

      const channel = new DiscordChannel({
        config: { id: "discord-main", platform: "discord", tokenReference: "ref", enabled: true },
        token: "test-bot-token",
        client,
        gateway: mock.gateway,
        scheduleReconnectFn: (cb) => setTimeout(cb, 0),
        clearReconnectFn: (t) => clearTimeout(t),
      });

      await channel.connect();
      await mock.simulateReady();

      const outbound: ChannelMessage = {
        id: "out-voice",
        platform: "discord",
        channelId: "dc-channel-1",
        sender: { id: "reins-agent", isBot: true },
        timestamp: new Date(),
        voice: {
          url: "https://example.com/voice.ogg",
          mimeType: "audio/ogg",
          platformData: { filename: "voice.ogg" },
        },
        platformData: { channel_id: "dc-channel-1" },
      };

      await channel.send(outbound);

      expect(client.sentFiles).toHaveLength(1);
      expect(client.sentFiles[0]!.channelId).toBe("dc-channel-1");
      expect(client.sentFiles[0]!.file.name).toBe("voice.ogg");

      await channel.disconnect();
    });
  });
});
