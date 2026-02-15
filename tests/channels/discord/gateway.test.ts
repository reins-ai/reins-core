import { describe, expect, it } from "bun:test";

import { DiscordGateway } from "../../../src/channels/discord/gateway";
import { DEFAULT_DISCORD_GATEWAY_INTENTS } from "../../../src/channels/discord/types";

type EventName = "open" | "message" | "close" | "error";

interface ListenerMap {
  open: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
  close: Array<(event: { code: number; reason: string }) => void>;
  error: Array<(event: { error?: unknown }) => void>;
}

class MockWebSocket {
  public readonly url: string;
  public sent: string[] = [];
  public closedWith: { code?: number; reason?: string } | null = null;

  private readonly listeners: ListenerMap = {
    open: [],
    message: [],
    close: [],
    error: [],
  };

  constructor(url: string) {
    this.url = url;
  }

  public send(data: string): void {
    this.sent.push(data);
  }

  public close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.emitClose(code ?? 1000, reason ?? "");
  }

  public addEventListener(type: "open", listener: () => void): void;
  public addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  public addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  public addEventListener(type: "error", listener: (event: { error?: unknown }) => void): void;
  public addEventListener(type: EventName, listener: unknown): void {
    const typed = listener as never;
    this.listeners[type].push(typed);
  }

  public removeEventListener(type: "open", listener: () => void): void;
  public removeEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  public removeEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
  public removeEventListener(type: "error", listener: (event: { error?: unknown }) => void): void;
  public removeEventListener(type: EventName, listener: unknown): void {
    const entries = this.listeners[type] as unknown[];
    const index = entries.indexOf(listener);
    if (index >= 0) {
      entries.splice(index, 1);
    }
  }

  public emitOpen(): void {
    for (const listener of this.listeners.open) {
      listener();
    }
  }

  public emitMessage(payload: unknown): void {
    const event = {
      data: JSON.stringify(payload),
    };
    for (const listener of this.listeners.message) {
      listener(event);
    }
  }

  public emitClose(code: number, reason: string): void {
    for (const listener of this.listeners.close) {
      listener({ code, reason });
    }
  }
}

class IntervalScheduler {
  public delays: number[] = [];
  public cleared: number[] = [];

  private nextId = 1;
  private readonly callbacks = new Map<number, () => void>();

  public schedule = (callback: () => void, delayMs: number): ReturnType<typeof setInterval> => {
    const id = this.nextId;
    this.nextId += 1;
    this.delays.push(delayMs);
    this.callbacks.set(id, callback);
    return id as ReturnType<typeof setInterval>;
  };

  public clear = (timer: ReturnType<typeof setInterval>): void => {
    const id = timer as unknown as number;
    this.cleared.push(id);
    this.callbacks.delete(id);
  };

  public tick(id: number): void {
    const callback = this.callbacks.get(id);
    if (callback !== undefined) {
      callback();
    }
  }

  public firstTimerId(): number {
    return 1;
  }
}

function parsePayload(payload: string): Record<string, unknown> {
  return JSON.parse(payload) as Record<string, unknown>;
}

describe("DiscordGateway", () => {
  it("connects and sends IDENTIFY after HELLO", async () => {
    const scheduler = new IntervalScheduler();
    const sockets: MockWebSocket[] = [];

    const gateway = new DiscordGateway({
      token: "bot-token",
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      scheduleHeartbeatFn: scheduler.schedule,
      clearHeartbeatFn: scheduler.clear,
    });

    const connectPromise = gateway.connect();
    const socket = sockets[0]!;
    expect(socket.url).toBe("wss://gateway.discord.gg/?v=10&encoding=json");
    socket.emitOpen();
    await connectPromise;

    socket.emitMessage({
      op: 10,
      d: { heartbeat_interval: 45_000 },
      s: null,
      t: null,
    });

    expect(scheduler.delays).toEqual([45_000]);
    expect(socket.sent).toHaveLength(2);

    const identify = parsePayload(socket.sent[1]!);
    expect(identify.op).toBe(2);

    const identifyData = identify.d as Record<string, unknown>;
    expect(identifyData.token).toBe("bot-token");
    expect(identifyData.intents).toBe(DEFAULT_DISCORD_GATEWAY_INTENTS);
  });

  it("emits MESSAGE_CREATE events to subscribers", async () => {
    const scheduler = new IntervalScheduler();
    const sockets: MockWebSocket[] = [];
    const received: string[] = [];

    const gateway = new DiscordGateway({
      token: "bot-token",
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      scheduleHeartbeatFn: scheduler.schedule,
      clearHeartbeatFn: scheduler.clear,
    });

    gateway.onMessageCreate((message) => {
      received.push(message.content);
    });

    const connectPromise = gateway.connect();
    const socket = sockets[0]!;
    socket.emitOpen();
    await connectPromise;

    socket.emitMessage({
      op: 10,
      d: { heartbeat_interval: 10_000 },
      s: null,
      t: null,
    });

    socket.emitMessage({
      op: 0,
      s: 42,
      t: "MESSAGE_CREATE",
      d: {
        id: "message-1",
        channel_id: "channel-1",
        author: {
          id: "user-1",
          username: "someone",
          discriminator: "0001",
        },
        content: "hello",
        timestamp: "2026-02-15T00:00:00.000Z",
        embeds: [],
        attachments: [],
      },
    });

    expect(received).toEqual(["hello"]);

    scheduler.tick(scheduler.firstTimerId());
    const heartbeatPayload = parsePayload(socket.sent[socket.sent.length - 1]!);
    expect(heartbeatPayload.op).toBe(1);
    expect(heartbeatPayload.d).toBe(42);
  });

  it("handles READY events", async () => {
    const scheduler = new IntervalScheduler();
    const sockets: MockWebSocket[] = [];
    const sessionIds: string[] = [];

    const gateway = new DiscordGateway({
      token: "bot-token",
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      scheduleHeartbeatFn: scheduler.schedule,
      clearHeartbeatFn: scheduler.clear,
    });

    gateway.onReady((event) => {
      sessionIds.push(event.session_id);
    });

    const connectPromise = gateway.connect();
    const socket = sockets[0]!;
    socket.emitOpen();
    await connectPromise;

    socket.emitMessage({
      op: 0,
      s: 1,
      t: "READY",
      d: {
        v: 10,
        session_id: "session-abc",
        user: {
          id: "bot",
          username: "reins-bot",
          discriminator: "0001",
          bot: true,
        },
      },
    });

    expect(sessionIds).toEqual(["session-abc"]);
  });

  it("disconnects and clears heartbeat interval", async () => {
    const scheduler = new IntervalScheduler();
    const sockets: MockWebSocket[] = [];

    const gateway = new DiscordGateway({
      token: "bot-token",
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      scheduleHeartbeatFn: scheduler.schedule,
      clearHeartbeatFn: scheduler.clear,
    });

    const connectPromise = gateway.connect();
    const socket = sockets[0]!;
    socket.emitOpen();
    await connectPromise;

    socket.emitMessage({
      op: 10,
      d: { heartbeat_interval: 15_000 },
      s: null,
      t: null,
    });

    await gateway.disconnect();

    expect(socket.closedWith).toEqual({ code: 1000, reason: "Client disconnect" });
    expect(scheduler.cleared).toEqual([1]);
    expect(gateway.connected).toBe(false);
  });
});
