import { describe, expect, it } from "bun:test";

import { ChannelRegistry } from "../../src/channels/registry";
import type {
  Channel,
  ChannelConfig,
  ChannelMessage,
  ChannelMessageHandler,
  ChannelPlatform,
  ChannelStatus,
} from "../../src/channels/types";
import { createChannelRouteHandler } from "../../src/daemon/channel-routes";
import { ChannelDaemonService } from "../../src/daemon/channel-service";

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
  public failInbound = false;

  async routeInbound(channelMessage: ChannelMessage): Promise<void> {
    if (this.failInbound) {
      throw new Error("bridge failure");
    }

    this.inboundMessages.push(channelMessage);
  }
}

class MockChannel implements Channel {
  public readonly config: ChannelConfig;
  public status: ChannelStatus = { state: "disconnected", uptimeMs: 0 };
  public connectCalls = 0;
  public disconnectCalls = 0;

  private readonly handlers = new Set<ChannelMessageHandler>();

  constructor(config: ChannelConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.status = {
      state: "connected",
      uptimeMs: 100,
    };
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.status = {
      state: "disconnected",
      uptimeMs: 0,
    };
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

function createInboundMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: overrides.id ?? "inbound-1",
    platform: overrides.platform ?? "telegram",
    channelId: overrides.channelId ?? "chat-1",
    conversationId: overrides.conversationId,
    sender: overrides.sender ?? {
      id: "user-1",
      displayName: "User",
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

function createHarness() {
  const registry = new ChannelRegistry();
  const bridge = new MockConversationBridge();
  const credentialStorage = new InMemoryChannelCredentialStorage();
  const channelsById = new Map<string, MockChannel>();

  const service = new ChannelDaemonService({
    channelRegistry: registry,
    conversationBridge: bridge,
    credentialStorage,
    channelFactory: (platform, channelId) => {
      const channel = new MockChannel({
        id: channelId,
        platform,
        tokenReference: `channel:${platform}`,
        enabled: true,
      });
      channelsById.set(channelId, channel);
      return channel;
    },
    nowFn: () => new Date("2026-02-15T12:00:00.000Z"),
  });

  return {
    service,
    registry,
    bridge,
    credentialStorage,
    channelsById,
  };
}

describe("ChannelDaemonService", () => {
  it("auto-starts enabled channels discovered on daemon boot", async () => {
    const harness = createHarness();
    await harness.credentialStorage.saveToken("telegram", "tg-token");

    await harness.service.start();

    const channel = harness.registry.get("telegram") as MockChannel | undefined;
    expect(channel).toBeDefined();
    expect(channel?.connectCalls).toBe(1);

    const status = harness.service.getChannelStatus("telegram");
    expect(status?.healthy).toBe(true);
    expect(status?.state).toBe("connected");
  });

  it("starts, stops, enables, disables, and removes channels", async () => {
    const harness = createHarness();
    await harness.service.start();

    const added = await harness.service.addChannel("discord", "dc-token");
    expect(added.channelId).toBe("discord");
    expect(added.healthy).toBe(true);

    const disabled = await harness.service.disableChannel("discord");
    expect(disabled.enabled).toBe(false);
    expect(disabled.state).toBe("disconnected");

    const enabled = await harness.service.enableChannel("discord");
    expect(enabled.enabled).toBe(true);
    expect(enabled.state).toBe("connected");

    const removed = await harness.service.removeChannel("discord");
    expect(removed).toBe(true);
    expect(harness.registry.get("discord")).toBeUndefined();

    await harness.service.stop();
  });

  it("tracks inbound health diagnostics for status reporting", async () => {
    const harness = createHarness();
    await harness.service.start();
    await harness.service.addChannel("telegram", "tg-token");

    const channel = harness.channelsById.get("telegram");
    expect(channel).toBeDefined();

    await channel?.emitInbound(createInboundMessage({ id: "m1" }));

    const statusAfterSuccess = harness.service.getChannelStatus("telegram");
    expect(statusAfterSuccess?.lastMessageAt).toBe("2026-02-15T12:00:00.000Z");
    expect(statusAfterSuccess?.lastError).toBeUndefined();

    harness.bridge.failInbound = true;
    await channel?.emitInbound(createInboundMessage({ id: "m2" }));

    const statusAfterFailure = harness.service.getChannelStatus("telegram");
    expect(statusAfterFailure?.lastError).toContain("bridge failure");
  });
});

describe("channel route handlers", () => {
  it("handles channel management API routes", async () => {
    const harness = createHarness();
    await harness.service.start();

    const handler = createChannelRouteHandler({
      channelService: harness.service,
    });

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
    };

    const addResponse = await handler.handle(
      new URL("http://localhost/channels/add"),
      "POST",
      new Request("http://localhost/channels/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "telegram", token: "tg-token" }),
      }),
      corsHeaders,
    );
    expect(addResponse?.status).toBe(201);

    const listResponse = await handler.handle(
      new URL("http://localhost/channels"),
      "GET",
      new Request("http://localhost/channels"),
      corsHeaders,
    );
    expect(listResponse?.status).toBe(200);
    const listBody = await listResponse?.json() as { channels: Array<{ channelId: string }> };
    expect(listBody.channels.length).toBe(1);
    expect(listBody.channels[0]?.channelId).toBe("telegram");

    const disableResponse = await handler.handle(
      new URL("http://localhost/channels/disable"),
      "POST",
      new Request("http://localhost/channels/disable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: "telegram" }),
      }),
      corsHeaders,
    );
    expect(disableResponse?.status).toBe(200);

    const statusResponse = await handler.handle(
      new URL("http://localhost/channels/status"),
      "GET",
      new Request("http://localhost/channels/status"),
      corsHeaders,
    );
    expect(statusResponse?.status).toBe(200);
    const statusBody = await statusResponse?.json() as { summary: { total: number; enabled: number } };
    expect(statusBody.summary.total).toBe(1);
    expect(statusBody.summary.enabled).toBe(0);

    const removeResponse = await handler.handle(
      new URL("http://localhost/channels/remove"),
      "POST",
      new Request("http://localhost/channels/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: "telegram" }),
      }),
      corsHeaders,
    );
    expect(removeResponse?.status).toBe(200);
  });

  it("returns validation errors for malformed requests", async () => {
    const harness = createHarness();
    await harness.service.start();
    const handler = createChannelRouteHandler({ channelService: harness.service });

    const response = await handler.handle(
      new URL("http://localhost/channels/add"),
      "POST",
      new Request("http://localhost/channels/add", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform: "slack", token: "x" }),
      }),
      { "Access-Control-Allow-Origin": "*" },
    );

    expect(response?.status).toBe(400);
  });
});
