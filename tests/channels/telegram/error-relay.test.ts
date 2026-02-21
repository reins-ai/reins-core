import { describe, expect, it } from "bun:test";

import { ChannelRegistry } from "../../../src/channels/registry";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelPlatform,
  ChannelStatus,
} from "../../../src/channels/types";
import { ChannelDaemonService } from "../../../src/daemon/channel-service";

class InMemoryChannelCredentialStorage {
  private readonly tokensByPlatform = new Map<ChannelPlatform, string>();

  async saveToken(platform: ChannelPlatform, token: string): Promise<void> {
    this.tokensByPlatform.set(platform, token);
  }

  async getToken(platform: ChannelPlatform): Promise<string | null> {
    return this.tokensByPlatform.get(platform) ?? null;
  }

  async deleteToken(platform: ChannelPlatform): Promise<boolean> {
    return this.tokensByPlatform.delete(platform);
  }

  async listTokens(): Promise<Array<{ platform: ChannelPlatform }>> {
    return Array.from(this.tokensByPlatform.keys()).map((platform) => ({ platform }));
  }
}

class MockConversationBridge {
  public readonly outboundMessages: Array<{ conversationId: string; text: string; channelId: string }> = [];

  async routeInbound(channelMessage: ChannelMessage, sourceChannel: Channel): Promise<{
    conversationId: string;
    assistantMessageId: string;
    source: { channelId: string; platform: ChannelPlatform };
  }> {
    return {
      conversationId: channelMessage.conversationId ?? "conv-1",
      assistantMessageId: `assistant-${channelMessage.id}`,
      source: {
        channelId: sourceChannel.config.id,
        platform: sourceChannel.config.platform,
      },
    };
  }

  async routeOutbound(
    agentResponse: { conversationId: string; text: string },
    sourceChannel: Channel,
  ): Promise<void> {
    this.outboundMessages.push({
      conversationId: agentResponse.conversationId,
      text: agentResponse.text,
      channelId: sourceChannel.config.id,
    });
  }
}

class MockChannel implements Channel {
  public readonly config: ChannelConfig;
  public status: ChannelStatus = { state: "disconnected", uptimeMs: 0 };

  private readonly handlers = new Set<ChannelMessageHandler>();

  constructor(config: ChannelConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.status = { state: "connected", uptimeMs: 100 };
  }

  async disconnect(): Promise<void> {
    this.status = { state: "disconnected", uptimeMs: 0 };
  }

  async send(_message: ChannelMessage): Promise<void> {
    return;
  }

  onMessage(handler: ChannelMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  async emitInbound(message: ChannelMessage): Promise<void> {
    for (const handler of this.handlers) {
      await handler(message);
    }
  }
}

function createInboundMessage(conversationId = "conv-1"): ChannelMessage {
  return {
    id: "inbound-1",
    platform: "telegram",
    channelId: "chat-telegram-1",
    conversationId,
    sender: {
      id: "user-1",
      isBot: false,
    },
    timestamp: new Date("2026-02-21T12:00:00.000Z"),
    text: "hello",
  };
}

async function createServiceHarness(): Promise<{
  service: ChannelDaemonService;
  bridge: MockConversationBridge;
  channel: MockChannel;
}> {
  const channelRegistry = new ChannelRegistry();
  const bridge = new MockConversationBridge();
  const credentialStorage = new InMemoryChannelCredentialStorage();

  const channel = new MockChannel({
    id: "telegram",
    platform: "telegram",
    tokenReference: "channel:telegram",
    enabled: true,
  });

  const service = new ChannelDaemonService({
    channelRegistry,
    conversationBridge: bridge,
    credentialStorage,
    channelFactory: () => channel,
  });

  await service.start();
  await service.addChannel("telegram", "telegram-token");
  await channel.emitInbound(createInboundMessage());

  return { service, bridge, channel };
}

describe("Telegram agent error relay", () => {
  it("relays UNAUTHORIZED as an authentication-required user message", async () => {
    const { service, bridge } = await createServiceHarness();

    const forwarded = await service.forwardAssistantError(
      "conv-1",
      "UNAUTHORIZED",
      "Credentials expired for anthropic",
      "assistant-inbound-1",
    );

    expect(forwarded).toBe(true);
    expect(bridge.outboundMessages).toHaveLength(1);
    expect(bridge.outboundMessages[0]!.text).toBe(
      "⚠️ Authentication required. Please run /connect in the Reins app to reconnect your AI provider.",
    );
  });

  it("relays generic failures with a safe fallback error message", async () => {
    const { service, bridge } = await createServiceHarness();

    const forwarded = await service.forwardAssistantError(
      "conv-1",
      "INTERNAL_ERROR",
      "Unexpected failure",
      "assistant-inbound-1",
    );

    expect(forwarded).toBe(true);
    expect(bridge.outboundMessages).toHaveLength(1);
    expect(bridge.outboundMessages[0]!.text).toBe(
      "⚠️ Something went wrong. Please try again.",
    );
  });

  it("sends fallback text when assistant response is empty", async () => {
    const { service, bridge } = await createServiceHarness();

    const forwarded = await service.forwardAssistantResponse(
      "conv-1",
      "   ",
      "assistant-inbound-1",
    );

    expect(forwarded).toBe(true);
    expect(bridge.outboundMessages).toHaveLength(1);
    expect(bridge.outboundMessages[0]!.text).toBe(
      "⚠️ No response generated. Please try again.",
    );
  });
});
