import { describe, expect, it } from "bun:test";

import { ConversationManager } from "../../src/conversation/manager";
import { InMemoryConversationStore } from "../../src/conversation/memory-store";
import { ConversationBridge } from "../../src/channels/conversation-bridge";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelStatus,
} from "../../src/channels/types";

function createConversationManager(): ConversationManager {
  return new ConversationManager(new InMemoryConversationStore());
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
    uptimeMs: 100,
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
    id: overrides.id ?? "inbound-1",
    platform: overrides.platform ?? "telegram",
    channelId: overrides.channelId ?? "chat-1",
    conversationId: overrides.conversationId,
    sender: overrides.sender ?? {
      id: "channel-user-1",
      username: "alice",
      displayName: "Alice",
      isBot: false,
    },
    timestamp: overrides.timestamp ?? new Date("2026-02-15T10:00:00.000Z"),
    text: overrides.text ?? "hello",
    attachments: overrides.attachments,
    formatting: overrides.formatting,
    voice: overrides.voice,
    replyToMessageId: overrides.replyToMessageId,
    platformData: overrides.platformData,
  };
}

describe("ConversationBridge", () => {
  it("keeps one unified conversation across TUI, Telegram, Discord, and back to TUI", async () => {
    const manager = createConversationManager();
    const telegram = createMockChannel({ id: "telegram-main", platform: "telegram" });
    const discord = createMockChannel({ id: "discord-main", platform: "discord" });

    const bridge = new ConversationBridge({
      conversationManager: manager,
      userKeyResolver: (message) => {
        const userId = message.platformData?.unified_user_id;
        return typeof userId === "string" ? userId : undefined;
      },
    });

    const tuiConversation = await manager.create({
      title: "TUI start",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });

    await manager.addMessage(tuiConversation.id, {
      role: "user",
      content: "Started in TUI",
      channelSource: {
        platform: "tui",
        channelId: "tui-main",
      },
    });

    bridge.bindUserConversation("user-123", tuiConversation.id);

    const telegramResult = await bridge.routeInbound(
      createInboundMessage({
        id: "tg-1",
        platform: "telegram",
        channelId: "tg-chat",
        text: "continued in telegram",
        platformData: { unified_user_id: "user-123" },
      }),
      telegram,
    );

    const discordResult = await bridge.routeInbound(
      createInboundMessage({
        id: "dc-1",
        platform: "discord",
        channelId: "dc-room",
        text: "continued in discord",
        platformData: { unified_user_id: "user-123" },
      }),
      discord,
    );

    await manager.addMessage(tuiConversation.id, {
      role: "user",
      content: "back in TUI",
      channelSource: {
        platform: "tui",
        channelId: "tui-main",
      },
    });

    expect(telegramResult.conversationId).toBe(tuiConversation.id);
    expect(discordResult.conversationId).toBe(tuiConversation.id);

    const history = await manager.getHistory(tuiConversation.id);
    const userMessages = history.filter((message) => message.role === "user");
    expect(userMessages).toHaveLength(4);
    expect(userMessages[0]?.channelSource?.platform).toBe("tui");
    expect(userMessages[1]?.channelSource?.platform).toBe("telegram");
    expect(userMessages[2]?.channelSource?.platform).toBe("discord");
    expect(userMessages[3]?.channelSource?.platform).toBe("tui");
  });

  it("tracks channel source attribution on messages written from router", async () => {
    const manager = createConversationManager();
    const telegram = createMockChannel({ id: "telegram-main", platform: "telegram" });
    const bridge = new ConversationBridge({ conversationManager: manager });

    const result = await bridge.routeInbound(
      createInboundMessage({
        id: "tg-attribute-1",
        channelId: "tg-chat",
        text: "attribute me",
      }),
      telegram,
    );

    const history = await manager.getHistory(result.conversationId);
    const userMessage = history.find((message) => message.role === "user");
    const assistantMessage = history.find((message) => message.role === "assistant");

    expect(userMessage?.channelSource).toEqual({
      platform: "telegram",
      channelId: "telegram-main",
    });
    expect(assistantMessage?.channelSource).toEqual({
      platform: "telegram",
      channelId: "telegram-main",
    });
  });

  it("deduplicates repeated inbound channel events", async () => {
    const manager = createConversationManager();
    const telegram = createMockChannel({ id: "telegram-main", platform: "telegram" });
    const bridge = new ConversationBridge({ conversationManager: manager });

    const inbound = createInboundMessage({
      id: "dup-msg-1",
      platform: "telegram",
      channelId: "tg-chat",
      text: "same event",
    });

    const first = await bridge.routeInbound(inbound, telegram);
    const second = await bridge.routeInbound(inbound, telegram);

    expect(second.conversationId).toBe(first.conversationId);
    expect(second.userMessageId).toBe(first.userMessageId);
    expect(second.assistantMessageId).toBe(first.assistantMessageId);

    const history = await manager.getHistory(first.conversationId);
    expect(history.filter((message) => message.role === "user")).toHaveLength(1);
    expect(history.filter((message) => message.role === "assistant")).toHaveLength(1);
  });

  it("broadcasts assistant responses to all active channel destinations", async () => {
    const manager = createConversationManager();
    const telegram = createMockChannel({ id: "telegram-main", platform: "telegram" });
    const discord = createMockChannel({ id: "discord-main", platform: "discord" });

    const bridge = new ConversationBridge({
      conversationManager: manager,
      broadcastResponses: true,
      channelRegistry: {
        list(): Channel[] {
          return [telegram, discord];
        },
      },
    });

    await bridge.routeInbound(
      createInboundMessage({
        id: "tg-route",
        platform: "telegram",
        channelId: "tg-chat",
      }),
      telegram,
    );

    await bridge.routeInbound(
      createInboundMessage({
        id: "dc-route",
        platform: "discord",
        channelId: "dc-room",
      }),
      discord,
    );

    await bridge.routeOutbound(
      {
        conversationId: bridge.getConversationForUser("telegram:channel-user-1") ?? "",
        text: "broadcast reply",
      },
      telegram,
    );

    expect(telegram.sentMessages).toHaveLength(1);
    expect(discord.sentMessages).toHaveLength(1);
    expect(telegram.sentMessages[0]?.channelId).toBe("tg-chat");
    expect(discord.sentMessages[0]?.channelId).toBe("dc-room");
  });
});
