import { describe, expect, it } from "bun:test";
import { ChannelDaemonService } from "../../src/daemon/channel-service";
import { ChannelRegistry } from "../../src/channels/registry";
import { InMemoryChannelAuthStorage } from "../../src/channels/memory-auth-storage";
import { ChannelAuthService } from "../../src/channels/auth-service";
import { MockChannel } from "../channels/mock-channel";
import type {
  Channel,
  ChannelMessage,
  ChannelPlatform,
} from "../../src/channels/types";

// ---------------------------------------------------------------------------
// Minimal mocks — follow existing channel-service.test.ts patterns
// ---------------------------------------------------------------------------

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
  public readonly inboundMessages: ChannelMessage[] = [];

  async routeInbound(channelMessage: ChannelMessage, sourceChannel: Channel): Promise<{
    conversationId: string;
    assistantMessageId: string;
    source: { channelId: string; platform: ChannelPlatform };
  }> {
    this.inboundMessages.push(channelMessage);
    return {
      conversationId: channelMessage.conversationId ?? "conversation-1",
      assistantMessageId: `assistant-${channelMessage.id}`,
      source: {
        channelId: sourceChannel.config.id,
        platform: sourceChannel.config.platform,
      },
    };
  }

  async routeOutbound(): Promise<void> {}
}

function makeInboundMessage(
  senderId: string,
  channelId = "test-channel",
): ChannelMessage {
  return {
    id: "msg-1",
    platform: "telegram",
    channelId,
    sender: { id: senderId },
    timestamp: new Date("2026-02-15T10:00:00.000Z"),
    text: "Hello bot",
  };
}

interface AuthHarness {
  service: ChannelDaemonService;
  channel: MockChannel;
  bridge: MockConversationBridge;
}

function createAuthHarness(options: {
  authUsers?: Record<string, string[]>;
}): AuthHarness {
  const { authUsers } = options;
  const registry = new ChannelRegistry();
  const bridge = new MockConversationBridge();
  const credentialStorage = new InMemoryChannelCredentialStorage();
  const channel = new MockChannel({
    config: { id: "test-channel", platform: "telegram" },
  });

  const authStorage = new InMemoryChannelAuthStorage(authUsers);
  const authService = new ChannelAuthService(authStorage);

  const service = new ChannelDaemonService({
    channelRegistry: registry,
    conversationBridge: bridge,
    credentialStorage,
    authService,
    channelFactory: () => channel,
    nowFn: () => new Date("2026-02-15T12:00:00.000Z"),
  });

  return { service, channel, bridge };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelDaemonService — auth enforcement", () => {
  it("rejects unauthorized sender and sends rejection reply via channel.send()", async () => {
    const { service, channel, bridge } = createAuthHarness({
      authUsers: {},
    });

    await service.addChannel("telegram", "tg-token", "test-channel");

    const message = makeInboundMessage("user123");
    await channel.simulateInbound(message);

    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]?.text).toContain("not authorized");
    expect(channel.sentMessages[0]?.text).toContain("user123");
    expect(channel.sentMessages[0]?.text).toContain("/auth test-channel user123");

    expect(bridge.inboundMessages).toHaveLength(0);
  });

  it("routes authorized sender to conversation bridge (no rejection)", async () => {
    const { service, channel, bridge } = createAuthHarness({
      authUsers: { "test-channel": ["user123"] },
    });

    await service.addChannel("telegram", "tg-token", "test-channel");

    const message = makeInboundMessage("user123");
    await channel.simulateInbound(message);

    expect(channel.sentMessages).toHaveLength(0);
    expect(bridge.inboundMessages).toHaveLength(1);
    expect(bridge.inboundMessages[0]?.sender.id).toBe("user123");
  });

  it("rejects empty sender ID with generic rejection (no /auth command)", async () => {
    const { service, channel, bridge } = createAuthHarness({
      authUsers: { "test-channel": ["user123"] },
    });

    await service.addChannel("telegram", "tg-token", "test-channel");

    const message = makeInboundMessage("");
    await channel.simulateInbound(message);

    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]?.text).toContain("not authorized");
    // Generic message — should NOT contain /auth command with empty string
    expect(channel.sentMessages[0]?.text).not.toContain("/auth");

    expect(bridge.inboundMessages).toHaveLength(0);
  });

  it('rejects "0" sender ID with generic rejection', async () => {
    const { service, channel, bridge } = createAuthHarness({
      authUsers: { "test-channel": ["user123"] },
    });

    await service.addChannel("telegram", "tg-token", "test-channel");

    const message = makeInboundMessage("0");
    await channel.simulateInbound(message);

    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]?.text).toContain("not authorized");
    expect(channel.sentMessages[0]?.text).not.toContain("/auth");

    expect(bridge.inboundMessages).toHaveLength(0);
  });

  it("rejects whitespace-only sender ID with generic rejection", async () => {
    const { service, channel, bridge } = createAuthHarness({
      authUsers: { "test-channel": ["user123"] },
    });

    await service.addChannel("telegram", "tg-token", "test-channel");

    const message = makeInboundMessage("   ");
    await channel.simulateInbound(message);

    expect(channel.sentMessages).toHaveLength(1);
    expect(channel.sentMessages[0]?.text).toContain("not authorized");
    expect(channel.sentMessages[0]?.text).not.toContain("/auth");

    expect(bridge.inboundMessages).toHaveLength(0);
  });

  it("rejection message includes bot sender and correct platform", async () => {
    const { service, channel } = createAuthHarness({
      authUsers: {},
    });

    await service.addChannel("telegram", "tg-token", "test-channel");

    const message = makeInboundMessage("user456");
    await channel.simulateInbound(message);

    expect(channel.sentMessages).toHaveLength(1);
    const rejection = channel.sentMessages[0]!;
    expect(rejection.sender.id).toBe("bot");
    expect(rejection.platform).toBe("telegram");
    expect(rejection.channelId).toBe("test-channel");
  });

  it("does not send typing indicator for rejected messages", async () => {
    const { service, channel } = createAuthHarness({
      authUsers: {},
    });

    await service.addChannel("telegram", "tg-token", "test-channel");

    const message = makeInboundMessage("unauthorized-user");
    await channel.simulateInbound(message);

    // Auth rejection returns early before typing indicator
    expect(channel.typingIndicatorCalls).toHaveLength(0);
  });

  it("sends typing indicator for authorized messages", async () => {
    const { service, channel } = createAuthHarness({
      authUsers: { "test-channel": ["user123"] },
    });

    await service.addChannel("telegram", "tg-token", "test-channel");

    const message = makeInboundMessage("user123");
    await channel.simulateInbound(message);

    expect(channel.typingIndicatorCalls).toHaveLength(1);
  });
});
