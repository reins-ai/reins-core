import { describe, expect, it } from "bun:test";

import { formatForDiscord, formatForTelegram } from "../../src/channels/formatting";
import { ChannelRouter, type ChannelRouterConversationManager } from "../../src/channels/router";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../../src/channels/types";

interface AddedMessageRecord {
  conversationId: string;
  message: {
    role: "user" | "assistant" | "system" | "tool";
    content: string;
    metadata?: Record<string, unknown>;
  };
}

function createMockConversationManager(): {
  manager: ChannelRouterConversationManager;
  createdConversations: Array<{ id: string; title?: string }>;
  addedMessages: AddedMessageRecord[];
} {
  const createdConversations: Array<{ id: string; title?: string }> = [];
  const addedMessages: AddedMessageRecord[] = [];
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

function createMockChannel(config: Partial<ChannelConfig> = {}): Channel & { sentMessages: ChannelMessage[] } {
  const sentMessages: ChannelMessage[] = [];

  const channelConfig: ChannelConfig = {
    id: config.id ?? "telegram-main",
    platform: config.platform ?? "telegram",
    tokenReference: config.tokenReference ?? "token-ref",
    enabled: config.enabled ?? true,
  };

  const status: ChannelStatus = {
    state: "connected",
    uptimeMs: 10,
  };

  return {
    config: channelConfig,
    status,
    sentMessages,
    async connect(): Promise<void> {
      return;
    },
    async disconnect(): Promise<void> {
      return;
    },
    async send(message: ChannelMessage): Promise<void> {
      sentMessages.push(message);
    },
    onMessage(_handler: ChannelMessageHandler): () => void {
      return () => {
        return;
      };
    },
  };
}

function createInboundMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: overrides.id ?? "ext-msg-1",
    platform: overrides.platform ?? "telegram",
    channelId: overrides.channelId ?? "chat-123",
    conversationId: overrides.conversationId,
    sender: overrides.sender ?? {
      id: "user-1",
      username: "alice",
      displayName: "Alice",
      isBot: false,
    },
    timestamp: overrides.timestamp ?? new Date("2026-02-15T00:00:00.000Z"),
    text: overrides.text ?? "hello from telegram",
    attachments: overrides.attachments,
    formatting: overrides.formatting,
    voice: overrides.voice,
    replyToMessageId: overrides.replyToMessageId,
    platformData: overrides.platformData,
  };
}

describe("ChannelRouter", () => {
  it("routes inbound message to conversation manager with source attribution metadata", async () => {
    const now = new Date("2026-02-15T01:00:00.000Z");
    const { manager, createdConversations, addedMessages } = createMockConversationManager();
    const sourceChannel = createMockChannel({ id: "telegram-main", platform: "telegram" });
    const router = new ChannelRouter({
      conversationManager: manager,
      nowFn: () => now,
    });

    const inbound = createInboundMessage();
    const result = await router.routeInbound(inbound, sourceChannel);

    expect(createdConversations).toHaveLength(1);
    expect(result.conversationId).toBe("conv-1");
    expect(result.userMessageId).toBe("msg-1");
    expect(result.assistantMessageId).toBe("msg-2");
    expect(result.timestamp).toBe(now);
    expect(result.source).toEqual({ channelId: "telegram-main", platform: "telegram" });

    expect(addedMessages).toHaveLength(2);
    expect(addedMessages[0]).toEqual({
      conversationId: "conv-1",
      message: {
        role: "user",
        content: "hello from telegram",
        metadata: {
          channelSource: {
            channelId: "telegram-main",
            platform: "telegram",
          },
          channelMessageId: "ext-msg-1",
          channelDestinationId: "chat-123",
          senderId: "user-1",
        },
      },
    });

    const assistantMetadata = addedMessages[1]?.message.metadata;
    expect(addedMessages[1]?.message.role).toBe("assistant");
    expect(addedMessages[1]?.message.content).toBe("");
    expect(assistantMetadata?.channelSource).toEqual({
      channelId: "telegram-main",
      platform: "telegram",
    });
    expect(assistantMetadata?.status).toBe("pending");
    expect(assistantMetadata?.provider).toBe("anthropic");
    expect(assistantMetadata?.model).toBe("anthropic/claude-sonnet-4-5");
  });

  it("uses existing conversation id when routing inbound", async () => {
    const { manager, createdConversations, addedMessages } = createMockConversationManager();
    const sourceChannel = createMockChannel({ id: "discord-main", platform: "discord" });
    const router = new ChannelRouter({
      conversationManager: manager,
    });

    const inbound = createInboundMessage({
      platform: "discord",
      conversationId: "conv-existing",
      text: "continue the thread",
    });
    const result = await router.routeInbound(inbound, sourceChannel);

    expect(result.conversationId).toBe("conv-existing");
    expect(createdConversations).toHaveLength(0);
    expect(addedMessages[0]?.conversationId).toBe("conv-existing");
  });

  it("routes outbound response to the source channel", async () => {
    const now = new Date("2026-02-15T02:00:00.000Z");
    const { manager } = createMockConversationManager();
    const sourceChannel = createMockChannel({ id: "telegram-main", platform: "telegram" });
    const router = new ChannelRouter({
      conversationManager: manager,
      nowFn: () => now,
    });

    const inbound = createInboundMessage({
      conversationId: "conv-thread-1",
      channelId: "chat-456",
      text: "need help",
    });
    await router.routeInbound(inbound, sourceChannel);

    await router.routeOutbound(
      {
        conversationId: "conv-thread-1",
        text: "I can help with that.",
      },
      sourceChannel,
    );

    expect(sourceChannel.sentMessages).toHaveLength(1);
    const outbound = sourceChannel.sentMessages[0];
    expect(outbound?.platform).toBe("telegram");
    expect(outbound?.channelId).toBe("chat-456");
    expect(outbound?.conversationId).toBe("conv-thread-1");
    // Text is now formatted as Telegram MarkdownV2 (period escaped)
    expect(outbound?.text).toBe(formatForTelegram("I can help with that."));
    expect(outbound?.sender).toEqual({
      id: "reins-agent",
      displayName: "Reins",
      isBot: true,
    });
    expect(outbound?.timestamp).toBe(now);
    expect(outbound?.platformData?.source_channel_id).toBe("telegram-main");
  });

  it("prefers source channel destination over latest conversation route context", async () => {
    const { manager } = createMockConversationManager();
    const telegram = createMockChannel({ id: "telegram-main", platform: "telegram" });
    const discord = createMockChannel({ id: "discord-main", platform: "discord" });
    const router = new ChannelRouter({
      conversationManager: manager,
    });

    await router.routeInbound(
      createInboundMessage({
        conversationId: "conv-shared",
        channelId: "tg-chat",
        platform: "telegram",
        text: "from telegram",
      }),
      telegram,
    );

    await router.routeInbound(
      createInboundMessage({
        id: "dc-inbound-1",
        conversationId: "conv-shared",
        channelId: "dc-room",
        platform: "discord",
        text: "from discord",
      }),
      discord,
    );

    await router.routeOutbound(
      {
        conversationId: "conv-shared",
        text: "reply to telegram",
      },
      telegram,
    );

    expect(telegram.sentMessages).toHaveLength(1);
    expect(telegram.sentMessages[0]?.channelId).toBe("tg-chat");
    expect(discord.sentMessages).toHaveLength(0);
  });

  it("broadcasts outbound responses to all active channels with known destinations", async () => {
    const { manager } = createMockConversationManager();
    const telegram = createMockChannel({ id: "telegram-main", platform: "telegram", enabled: true });
    const discord = createMockChannel({ id: "discord-main", platform: "discord", enabled: true });
    const disconnected = createMockChannel({ id: "discord-idle", platform: "discord", enabled: true });
    disconnected.status.state = "disconnected";

    const registry = {
      list(): Channel[] {
        return [telegram, discord, disconnected];
      },
    };

    const router = new ChannelRouter({
      conversationManager: manager,
      channelRegistry: registry,
      broadcastResponses: true,
    });

    await router.routeInbound(
      createInboundMessage({
        conversationId: "conv-broadcast",
        channelId: "tg-chat",
        platform: "telegram",
      }),
      telegram,
    );

    await router.routeInbound(
      createInboundMessage({
        id: "discord-msg-1",
        conversationId: "conv-broadcast",
        channelId: "dc-channel",
        platform: "discord",
        text: "hello from discord",
      }),
      discord,
    );

    await router.routeOutbound(
      {
        conversationId: "conv-broadcast",
        text: "broadcast update",
      },
      telegram,
    );

    expect(telegram.sentMessages).toHaveLength(1);
    expect(discord.sentMessages).toHaveLength(1);
    expect(disconnected.sentMessages).toHaveLength(0);
    expect(telegram.sentMessages[0]?.channelId).toBe("tg-chat");
    expect(discord.sentMessages[0]?.channelId).toBe("dc-channel");
  });

  it("applies Telegram MarkdownV2 formatting to outbound messages", async () => {
    const { manager } = createMockConversationManager();
    const channel = createMockChannel({ id: "tg-1", platform: "telegram" });
    const router = new ChannelRouter({ conversationManager: manager });

    await router.routeInbound(
      createInboundMessage({
        conversationId: "conv-fmt-tg",
        channelId: "chat-tg",
        text: "hi",
      }),
      channel,
    );

    const rawText = "Hello. This is **bold** and *italic*!";
    await router.routeOutbound(
      { conversationId: "conv-fmt-tg", text: rawText },
      channel,
    );

    expect(channel.sentMessages).toHaveLength(1);
    const sent = channel.sentMessages[0]!;
    expect(sent.text).toBe(formatForTelegram(rawText));
    expect(sent.text).not.toBe(rawText);
  });

  it("applies Discord formatting to outbound messages", async () => {
    const { manager } = createMockConversationManager();
    const channel = createMockChannel({ id: "dc-1", platform: "discord" });
    const router = new ChannelRouter({ conversationManager: manager });

    await router.routeInbound(
      createInboundMessage({
        id: "dc-in-1",
        conversationId: "conv-fmt-dc",
        channelId: "dc-room",
        platform: "discord",
        text: "hi",
      }),
      channel,
    );

    const rawText = 'Check <a href="https://example.com">this link</a> out';
    await router.routeOutbound(
      { conversationId: "conv-fmt-dc", text: rawText },
      channel,
    );

    expect(channel.sentMessages).toHaveLength(1);
    const sent = channel.sentMessages[0]!;
    expect(sent.text).toBe(formatForDiscord(rawText));
    expect(sent.text).toContain("[this link](https://example.com)");
  });

  it("chunks long Telegram messages into multiple send calls", async () => {
    const { manager } = createMockConversationManager();
    const channel = createMockChannel({ id: "tg-chunk", platform: "telegram" });
    const router = new ChannelRouter({ conversationManager: manager });

    await router.routeInbound(
      createInboundMessage({
        conversationId: "conv-chunk",
        channelId: "chat-chunk",
        text: "start",
      }),
      channel,
    );

    // Create a message that will exceed 4096 chars after formatting
    const longText = "x".repeat(5000);
    await router.routeOutbound(
      { conversationId: "conv-chunk", text: longText },
      channel,
    );

    expect(channel.sentMessages.length).toBeGreaterThan(1);
    for (const msg of channel.sentMessages) {
      expect(msg.text!.length).toBeLessThanOrEqual(4096);
    }
  });

  it("sends single message for short Telegram text", async () => {
    const { manager } = createMockConversationManager();
    const channel = createMockChannel({ id: "tg-short", platform: "telegram" });
    const router = new ChannelRouter({ conversationManager: manager });

    await router.routeInbound(
      createInboundMessage({
        conversationId: "conv-short",
        channelId: "chat-short",
        text: "hi",
      }),
      channel,
    );

    await router.routeOutbound(
      { conversationId: "conv-short", text: "Short reply" },
      channel,
    );

    expect(channel.sentMessages).toHaveLength(1);
  });

  it("sends empty-text messages without formatting", async () => {
    const { manager } = createMockConversationManager();
    const channel = createMockChannel({ id: "tg-empty", platform: "telegram" });
    const router = new ChannelRouter({ conversationManager: manager });

    await router.routeInbound(
      createInboundMessage({
        conversationId: "conv-empty",
        channelId: "chat-empty",
        text: "hi",
      }),
      channel,
    );

    await router.routeOutbound(
      { conversationId: "conv-empty", text: "" },
      channel,
    );

    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]!.text).toBe("");
  });
});
