import { describe, expect, it } from "bun:test";

import { CdpClient } from "../../src/browser/cdp-client";
import { CdpError } from "../../src/browser/errors";

type EventName = "open" | "message" | "close" | "error";

interface ListenerMap {
  open: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
  close: Array<(event: { code: number; reason: string }) => void>;
  error: Array<(event: { error?: unknown }) => void>;
}

class MockWebSocket {
  public readonly url: string;
  public readonly sent: string[] = [];
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

  public emitError(error?: unknown): void {
    for (const listener of this.listeners.error) {
      listener({ error });
    }
  }
}

class ManualTimer {
  public readonly delays: number[] = [];

  private now = 0;
  private nextId = 1;
  private readonly tasks = new Map<number, { dueAt: number; callback: () => void }>();

  public setTimeout = (callback: () => void, timeoutMs: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId;
    this.nextId += 1;
    this.delays.push(timeoutMs);
    this.tasks.set(id, {
      dueAt: this.now + timeoutMs,
      callback,
    });
    return id as ReturnType<typeof setTimeout>;
  };

  public clearTimeout = (timer: ReturnType<typeof setTimeout>): void => {
    const id = timer as unknown as number;
    this.tasks.delete(id);
  };

  public advanceBy(durationMs: number): void {
    this.now += durationMs;

    let ranTask = true;
    while (ranTask) {
      ranTask = false;

      for (const [id, task] of this.tasks) {
        if (task.dueAt <= this.now) {
          this.tasks.delete(id);
          task.callback();
          ranTask = true;
          break;
        }
      }
    }
  }
}

function createVersionResponse(webSocketDebuggerUrl: string): {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
} {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      webSocketDebuggerUrl,
    }),
  };
}

function parseSentCommand(payload: string): {
  id: number;
  method: string;
  sessionId?: string;
} {
  return JSON.parse(payload) as {
    id: number;
    method: string;
    sessionId?: string;
  };
}

async function waitForSocketCount(sockets: MockWebSocket[], expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (sockets.length >= expectedCount) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error(`Expected at least ${expectedCount} sockets to be created`);
}

async function advanceTimerUntilSocketCount(
  timer: ManualTimer,
  sockets: MockWebSocket[],
  expectedCount: number,
): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    timer.advanceBy(50);
    await Promise.resolve();
    if (sockets.length >= expectedCount) {
      return;
    }
  }

  throw new Error(`Expected at least ${expectedCount} sockets after advancing timer`);
}

async function waitForSentCommand(socket: MockWebSocket): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (socket.sent.length > 0) {
      return;
    }
    await Promise.resolve();
  }

  throw new Error("Expected socket to send at least one command");
}

describe("CdpClient", () => {
  it("correlates command responses by monotonic id", async () => {
    const sockets: MockWebSocket[] = [];

    const client = new CdpClient({
      port: 9222,
      fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/one"),
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const connectPromise = client.connect();
    await waitForSocketCount(sockets, 1);
    const socket = sockets[0]!;
    socket.emitOpen();
    await connectPromise;

    const first = client.send<{ targetInfos: string[] }>("Target.getTargets");
    const second = client.send<{ frameId: string }>("Page.navigate", {
      url: "https://example.com",
    });

    const sentFirst = parseSentCommand(socket.sent[0]!);
    const sentSecond = parseSentCommand(socket.sent[1]!);

    expect(sentFirst.id).toBe(1);
    expect(sentFirst.method).toBe("Target.getTargets");
    expect(sentSecond.id).toBe(2);
    expect(sentSecond.method).toBe("Page.navigate");

    socket.emitMessage({ id: 2, result: { frameId: "frame-1" } });
    socket.emitMessage({ id: 1, result: { targetInfos: ["tab-1"] } });

    await expect(first).resolves.toEqual({ targetInfos: ["tab-1"] });
    await expect(second).resolves.toEqual({ frameId: "frame-1" });
  });

  it("dispatches CDP events to listeners and supports unsubscribe", async () => {
    const sockets: MockWebSocket[] = [];
    const payloads: Array<Record<string, unknown>> = [];

    const client = new CdpClient({
      port: 9222,
      fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/two"),
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const connectPromise = client.connect();
    await waitForSocketCount(sockets, 1);
    const socket = sockets[0]!;
    socket.emitOpen();
    await connectPromise;

    const unsubscribe = client.on("Page.loadEventFired", (params) => {
      payloads.push(params);
    });

    socket.emitMessage({
      method: "Page.loadEventFired",
      params: { timestamp: 123 },
    });

    unsubscribe();

    socket.emitMessage({
      method: "Page.loadEventFired",
      params: { timestamp: 456 },
    });

    expect(payloads).toEqual([{ timestamp: 123 }]);
  });

  it("rejects command when command timeout elapses", async () => {
    const timer = new ManualTimer();
    const sockets: MockWebSocket[] = [];

    const client = new CdpClient({
      port: 9222,
      commandTimeout: 30,
      fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/three"),
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn: timer.setTimeout,
      clearTimeoutFn: timer.clearTimeout,
    });

    const connectPromise = client.connect();
    await waitForSocketCount(sockets, 1);
    const socket = sockets[0]!;
    socket.emitOpen();
    await connectPromise;

    const commandPromise = client.send("Target.getTargets");

    timer.advanceBy(30);

    await expect(commandPromise).rejects.toBeInstanceOf(CdpError);
  });

  it("includes sessionId in command payload when provided", async () => {
    const sockets: MockWebSocket[] = [];

    const client = new CdpClient({
      port: 9222,
      fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/session"),
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const connectPromise = client.connect();
    await waitForSocketCount(sockets, 1);
    const socket = sockets[0]!;
    socket.emitOpen();
    await connectPromise;

    const sendPromise = client.send("Page.navigate", { url: "https://example.com" }, "session-42");
    const sent = parseSentCommand(socket.sent[0]!);

    expect(sent.sessionId).toBe("session-42");

    socket.emitMessage({ id: sent.id, result: { frameId: "frame-1" } });
    await expect(sendPromise).resolves.toEqual({ frameId: "frame-1" });
  });

  it("rejects all pending commands on unexpected close", async () => {
    const sockets: MockWebSocket[] = [];

    const client = new CdpClient({
      port: 9222,
      fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/four"),
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
    });

    const connectPromise = client.connect();
    await waitForSocketCount(sockets, 1);
    const socket = sockets[0]!;
    socket.emitOpen();
    await connectPromise;

    const pending = client.send("Target.getTargets");

    socket.emitClose(1006, "abnormal closure");

    await expect(pending).rejects.toBeInstanceOf(CdpError);
  });

  it("retries reconnect and re-enables subscribed domains", async () => {
    const timer = new ManualTimer();
    const sockets: MockWebSocket[] = [];
    const reconnectAttempts: number[] = [];

    const client = new CdpClient({
      port: 9222,
      fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/five"),
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn: timer.setTimeout,
      clearTimeoutFn: timer.clearTimeout,
    });

    client.on("reconnecting", (params) => {
      reconnectAttempts.push(params.attempt as number);
    });

    const connectPromise = client.connect();
    await waitForSocketCount(sockets, 1);
    const initialSocket = sockets[0]!;
    initialSocket.emitOpen();
    await connectPromise;

    const enablePromise = client.send("Page.enable");
    initialSocket.emitMessage({ id: 1, result: {} });
    await enablePromise;

    initialSocket.emitClose(1006, "socket lost");

    await advanceTimerUntilSocketCount(timer, sockets, 2);
    const firstReconnectSocket = sockets[1]!;
    firstReconnectSocket.emitError(new Error("first reconnect failed"));
    await Promise.resolve();
    await Promise.resolve();

    await advanceTimerUntilSocketCount(timer, sockets, 3);
    const secondReconnectSocket = sockets[2]!;
    secondReconnectSocket.emitOpen();
    await waitForSentCommand(secondReconnectSocket);

    const resentEnable = parseSentCommand(secondReconnectSocket.sent[0]!);
    expect(resentEnable.method).toBe("Page.enable");
    secondReconnectSocket.emitMessage({ id: resentEnable.id, result: {} });

    await Promise.resolve();
    await Promise.resolve();

    expect(client.isConnected).toBe(true);
    expect(reconnectAttempts).toEqual([1, 2]);
  });

  it("fails connection when initial websocket open exceeds timeout", async () => {
    const timer = new ManualTimer();
    const sockets: MockWebSocket[] = [];

    const client = new CdpClient({
      port: 9222,
      timeout: 5_000,
      fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/six"),
      webSocketFactory: (url: string) => {
        const socket = new MockWebSocket(url);
        sockets.push(socket);
        return socket;
      },
      setTimeoutFn: timer.setTimeout,
      clearTimeoutFn: timer.clearTimeout,
    });

    const connectPromise = client.connect();
    await waitForSocketCount(sockets, 1);
    expect(sockets).toHaveLength(1);

    timer.advanceBy(5_000);

    await expect(connectPromise).rejects.toBeInstanceOf(CdpError);
  });
});
