import { describe, expect, it } from "bun:test";

import { ChannelError } from "../../../src/channels/errors";
import { DiscordChannel } from "../../../src/channels/discord/channel";
import type { DiscordGatewayReadyEvent, DiscordMessage, DiscordUser } from "../../../src/channels/discord/types";
import type { ChannelConfig, ChannelMessage } from "../../../src/channels/types";

interface ScheduledTask {
  id: number;
  delayMs: number;
  callback: () => void;
  cleared: boolean;
}

class ReconnectScheduler {
  public delays: number[] = [];

  private nextId = 1;
  private readonly tasks: ScheduledTask[] = [];

  public schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const task: ScheduledTask = {
      id: this.nextId,
      delayMs,
      callback,
      cleared: false,
    };
    this.nextId += 1;
    this.tasks.push(task);
    this.delays.push(delayMs);
    return task.id as ReturnType<typeof setTimeout>;
  };

  public clear = (timer: ReturnType<typeof setTimeout>): void => {
    const id = timer as unknown as number;
    const task = this.tasks.find((entry) => entry.id === id);
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
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

class MockDiscordClient {
  public getCurrentUserCalls = 0;
  public sendMessageCalls: Array<{ channelId: string; content: string }> = [];
  public sendEmbedCalls: Array<{ channelId: string; description?: string }> = [];
  public uploadFileCalls: Array<{ channelId: string; name: string; data: string; description?: string }> = [];

  private readonly getCurrentUserError: Error | null;

  constructor(options: { getCurrentUserError?: Error } = {}) {
    this.getCurrentUserError = options.getCurrentUserError ?? null;
  }

  public async getCurrentUser(): Promise<DiscordUser> {
    this.getCurrentUserCalls += 1;
    if (this.getCurrentUserError !== null) {
      throw this.getCurrentUserError;
    }

    return {
      id: "bot-id",
      username: "reins-bot",
      discriminator: "0001",
      bot: true,
    };
  }

  public async sendMessage(channelId: string, content: string): Promise<unknown> {
    this.sendMessageCalls.push({ channelId, content });
    return {};
  }

  public async sendEmbed(channelId: string, embed: { description?: string }): Promise<unknown> {
    this.sendEmbedCalls.push({ channelId, description: embed.description });
    return {};
  }

  public async uploadFile(
    channelId: string,
    file: { name: string; data: string; description?: string },
  ): Promise<unknown> {
    this.uploadFileCalls.push({ channelId, ...file });
    return {};
  }
}

class MockDiscordGateway {
  public connected = false;
  public currentSequence: number | null = null;
  public connectCalls = 0;
  public disconnectCalls = 0;
  public preparedResume: Array<{ sessionId: string; sequence: number }> = [];

  private readonly messageHandlers = new Set<(message: DiscordMessage) => Promise<void> | void>();
  private readonly readyHandlers = new Set<(event: DiscordGatewayReadyEvent) => Promise<void> | void>();
  private readonly disconnectHandlers = new Set<
    (details: { code?: number; reason?: string; error?: string }) => Promise<void> | void
  >();

  public async connect(): Promise<void> {
    this.connectCalls += 1;
    this.connected = true;
  }

  public async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  public onReady(handler: (event: DiscordGatewayReadyEvent) => Promise<void> | void): () => void {
    this.readyHandlers.add(handler);
    return () => {
      this.readyHandlers.delete(handler);
    };
  }

  public onMessageCreate(handler: (message: DiscordMessage) => Promise<void> | void): () => void {
    this.messageHandlers.add(handler);
    return () => {
      this.messageHandlers.delete(handler);
    };
  }

  public onDisconnect(
    handler: (details: { code?: number; reason?: string; error?: string }) => Promise<void> | void,
  ): () => void {
    this.disconnectHandlers.add(handler);
    return () => {
      this.disconnectHandlers.delete(handler);
    };
  }

  public prepareResume(sessionId: string, sequence: number): void {
    this.preparedResume.push({ sessionId, sequence });
  }

  public emitReady(event: DiscordGatewayReadyEvent): void {
    for (const handler of this.readyHandlers) {
      void handler(event);
    }
  }

  public emitMessage(message: DiscordMessage): void {
    for (const handler of this.messageHandlers) {
      void handler(message);
    }
  }

  public emitDisconnect(details: { code?: number; reason?: string; error?: string }): void {
    this.connected = false;
    for (const handler of this.disconnectHandlers) {
      void handler(details);
    }
  }
}

function createConfig(): ChannelConfig {
  return {
    id: "discord-main",
    platform: "discord",
    tokenReference: "cred://discord/main",
    enabled: true,
  };
}

function createDiscordEvent(overrides: Partial<DiscordMessage> = {}): DiscordMessage {
  return {
    id: "message-1",
    channel_id: "channel-1",
    author: {
      id: "user-1",
      username: "someone",
      discriminator: "0001",
      bot: false,
    },
    content: "hello",
    timestamp: "2026-02-15T00:00:00.000Z",
    embeds: [],
    attachments: [],
    ...overrides,
  };
}

function createOutboundMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "outbound-1",
    platform: "discord",
    channelId: "channel-1",
    sender: {
      id: "assistant",
      isBot: true,
    },
    timestamp: new Date(),
    text: "hello from reins",
    platformData: {
      channel_id: "channel-1",
    },
    ...overrides,
  };
}

describe("DiscordChannel", () => {
  it("connects by validating token and opening the gateway", async () => {
    const client = new MockDiscordClient();
    const gateway = new MockDiscordGateway();

    const channel = new DiscordChannel({
      config: createConfig(),
      token: "bot-token",
      client,
      gateway,
    });

    await channel.connect();
    gateway.emitReady({
      v: 10,
      session_id: "session-1",
      user: {
        id: "bot-id",
        username: "reins-bot",
        discriminator: "0001",
        bot: true,
      },
    });

    expect(client.getCurrentUserCalls).toBe(1);
    expect(gateway.connectCalls).toBe(1);
    expect(channel.status.state).toBe("connected");
  });

  it("receives MESSAGE_CREATE and dispatches normalized messages", async () => {
    const client = new MockDiscordClient();
    const gateway = new MockDiscordGateway();

    const channel = new DiscordChannel({
      config: createConfig(),
      token: "bot-token",
      client,
      gateway,
    });

    const received: string[] = [];
    channel.onMessage((message) => {
      received.push(message.text ?? "");
    });

    await channel.connect();
    gateway.emitReady({
      v: 10,
      session_id: "session-1",
      user: {
        id: "bot-id",
        username: "reins-bot",
        discriminator: "0001",
        bot: true,
      },
    });

    gateway.emitMessage(createDiscordEvent({ content: "incoming" }));
    await Promise.resolve();

    expect(received).toEqual(["incoming"]);
  });

  it("sends text and embed messages via Discord client", async () => {
    const client = new MockDiscordClient();
    const gateway = new MockDiscordGateway();

    const channel = new DiscordChannel({
      config: createConfig(),
      token: "bot-token",
      client,
      gateway,
    });

    await channel.connect();
    gateway.emitReady({
      v: 10,
      session_id: "session-1",
      user: {
        id: "bot-id",
        username: "reins-bot",
        discriminator: "0001",
        bot: true,
      },
    });

    await channel.send(createOutboundMessage({ text: "plain text" }));
    await channel.send(
      createOutboundMessage({
        text: "embed text",
        platformData: {
          channel_id: "channel-1",
          send_as_embed: true,
        },
      }),
    );

    expect(client.sendMessageCalls).toEqual([{ channelId: "channel-1", content: "plain text" }]);
    expect(client.sendEmbedCalls).toEqual([{ channelId: "channel-1", description: "embed text" }]);
  });

  it("disconnects and clears connection state", async () => {
    const client = new MockDiscordClient();
    const gateway = new MockDiscordGateway();

    const channel = new DiscordChannel({
      config: createConfig(),
      token: "bot-token",
      client,
      gateway,
    });

    await channel.connect();
    gateway.emitReady({
      v: 10,
      session_id: "session-1",
      user: {
        id: "bot-id",
        username: "reins-bot",
        discriminator: "0001",
        bot: true,
      },
    });

    await channel.disconnect();

    expect(gateway.disconnectCalls).toBe(1);
    expect(channel.status.state).toBe("disconnected");
  });

  it("reconnects with backoff and resumes session", async () => {
    const client = new MockDiscordClient();
    const scheduler = new ReconnectScheduler();
    const createdGateways: MockDiscordGateway[] = [];

    const channel = new DiscordChannel({
      config: createConfig(),
      token: "bot-token",
      client,
      gatewayFactory: () => {
        const gateway = new MockDiscordGateway();
        createdGateways.push(gateway);
        return gateway;
      },
      scheduleReconnectFn: scheduler.schedule,
      clearReconnectFn: scheduler.clear,
      initialReconnectDelayMs: 100,
      maxReconnectDelayMs: 1_000,
    });

    await channel.connect();
    const firstGateway = createdGateways[0]!;
    firstGateway.emitReady({
      v: 10,
      session_id: "session-1",
      resume_gateway_url: "wss://gateway.discord.gg/?v=10&encoding=json",
      user: {
        id: "bot-id",
        username: "reins-bot",
        discriminator: "0001",
        bot: true,
      },
    });

    firstGateway.currentSequence = 42;
    firstGateway.emitDisconnect({ reason: "network lost" });

    expect(channel.status.state).toBe("reconnecting");
    expect(channel.status.lastError).toContain("network lost");
    expect(scheduler.delays).toEqual([100]);

    await scheduler.flush(1);

    const secondGateway = createdGateways[1]!;
    expect(secondGateway.preparedResume).toEqual([{ sessionId: "session-1", sequence: 42 }]);

    secondGateway.emitReady({
      v: 10,
      session_id: "session-1",
      resume_gateway_url: "wss://gateway.discord.gg/?v=10&encoding=json",
      user: {
        id: "bot-id",
        username: "reins-bot",
        discriminator: "0001",
        bot: true,
      },
    });

    expect(channel.status.state).toBe("connected");
  });

  it("tracks error state when token validation fails", async () => {
    const client = new MockDiscordClient({
      getCurrentUserError: new Error("invalid token"),
    });

    const channel = new DiscordChannel({
      config: createConfig(),
      token: "bot-token",
      client,
      gateway: new MockDiscordGateway(),
    });

    await expect(channel.connect()).rejects.toThrow(ChannelError);
    expect(channel.status.state).toBe("error");
    expect(channel.status.lastError).toContain("invalid token");
  });

  it("supports unsubscribing message handlers", async () => {
    const client = new MockDiscordClient();
    const gateway = new MockDiscordGateway();

    const channel = new DiscordChannel({
      config: createConfig(),
      token: "bot-token",
      client,
      gateway,
    });

    const received: string[] = [];
    const unsubscribe = channel.onMessage((message) => {
      received.push(message.text ?? "");
    });
    unsubscribe();

    await channel.connect();
    gateway.emitReady({
      v: 10,
      session_id: "session-1",
      user: {
        id: "bot-id",
        username: "reins-bot",
        discriminator: "0001",
        bot: true,
      },
    });
    gateway.emitMessage(createDiscordEvent({ content: "ignored" }));
    await Promise.resolve();

    expect(received).toEqual([]);
  });

  it("throws when sending while disconnected", async () => {
    const channel = new DiscordChannel({
      config: createConfig(),
      token: "bot-token",
      client: new MockDiscordClient(),
      gateway: new MockDiscordGateway(),
    });

    await expect(channel.send(createOutboundMessage())).rejects.toThrow(ChannelError);
  });
});
