import { describe, expect, it } from "bun:test";

import { routeCliArgs } from "../../src/cli/index";
import { runOneshot } from "../../src/cli/commands/oneshot";
import { createStdoutStreamRenderer, type StdoutLike } from "../../src/cli/stdout-stream";

interface CloseEventLike {
  code: number;
  reason: string;
}

interface MessageEventLike {
  data: string;
}

class FakeStdout implements StdoutLike {
  public readonly writes: string[] = [];
  public isTTY = false;

  private readonly writeResults: boolean[];
  private readonly drainListeners = new Set<() => void>();

  constructor(writeResults: boolean[] = []) {
    this.writeResults = [...writeResults];
  }

  public write(chunk: string): boolean {
    this.writes.push(chunk);
    if (this.writeResults.length === 0) {
      return true;
    }

    const result = this.writeResults.shift();
    return result ?? true;
  }

  public once(event: "drain", listener: () => void): void {
    if (event !== "drain") {
      return;
    }

    this.drainListeners.add(listener);
  }

  public drain(): void {
    for (const listener of this.drainListeners) {
      listener();
    }
    this.drainListeners.clear();
  }
}

class FakeWebSocket {
  public readonly sent: string[] = [];

  private readonly listeners = {
    open: new Set<() => void>(),
    close: new Set<(event: CloseEventLike) => void>(),
    error: new Set<() => void>(),
    message: new Set<(event: MessageEventLike) => void>(),
  };

  constructor(private readonly onSend: (socket: FakeWebSocket, payload: string) => void) {
    queueMicrotask(() => {
      this.emitOpen();
    });
  }

  public send(payload: string): void {
    this.sent.push(payload);
    this.onSend(this, payload);
  }

  public close(code = 1000, reason = "closed"): void {
    this.emitClose({ code, reason });
  }

  public addEventListener(type: "open", listener: () => void): void;
  public addEventListener(type: "close", listener: (event: CloseEventLike) => void): void;
  public addEventListener(type: "error", listener: () => void): void;
  public addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  public addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (() => void) | ((event: CloseEventLike) => void) | ((event: MessageEventLike) => void),
  ): void {
    if (type === "open" || type === "error") {
      (this.listeners[type] as Set<() => void>).add(listener as () => void);
      return;
    }

    if (type === "close") {
      this.listeners.close.add(listener as (event: CloseEventLike) => void);
      return;
    }

    this.listeners.message.add(listener as (event: MessageEventLike) => void);
  }

  public removeEventListener(type: "open", listener: () => void): void;
  public removeEventListener(type: "close", listener: (event: CloseEventLike) => void): void;
  public removeEventListener(type: "error", listener: () => void): void;
  public removeEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  public removeEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (() => void) | ((event: CloseEventLike) => void) | ((event: MessageEventLike) => void),
  ): void {
    if (type === "open" || type === "error") {
      (this.listeners[type] as Set<() => void>).delete(listener as () => void);
      return;
    }

    if (type === "close") {
      this.listeners.close.delete(listener as (event: CloseEventLike) => void);
      return;
    }

    this.listeners.message.delete(listener as (event: MessageEventLike) => void);
  }

  public serverMessage(payload: unknown): void {
    const data = JSON.stringify(payload);
    for (const listener of this.listeners.message) {
      listener({ data });
    }
  }

  public serverClose(code = 1006, reason = "abnormal"): void {
    this.emitClose({ code, reason });
  }

  private emitOpen(): void {
    for (const listener of this.listeners.open) {
      listener();
    }
  }

  private emitClose(event: CloseEventLike): void {
    for (const listener of this.listeners.close) {
      listener(event);
    }
  }
}

function createJsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("oneshot stdout renderer", () => {
  it("respects backpressure and waits for drain", async () => {
    const stdout = new FakeStdout([false, true]);
    const renderer = createStdoutStreamRenderer(stdout);

    const first = renderer.writeChunk("hello");
    const second = renderer.writeChunk(" world");

    await Promise.resolve();
    expect(stdout.writes).toEqual(["hello"]);

    stdout.drain();
    await first;
    await second;
    await renderer.complete();

    expect(stdout.writes).toEqual(["hello", " world"]);
  });
});

describe("oneshot command", () => {
  it("dispatches query to daemon and streams chunks incrementally", async () => {
    const stdout = new FakeStdout();
    const stderr: string[] = [];
    const requests: Array<{ url: string; body: unknown }> = [];

    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.url;
      const body = init?.body ? JSON.parse(init.body.toString()) : undefined;
      requests.push({ url, body });

      return createJsonResponse({
        conversationId: "c-1",
        assistantMessageId: "a-1",
      });
    };

    const webSocketFactory = () =>
      new FakeWebSocket((socket, payload) => {
        const request = JSON.parse(payload) as { type: string };
        if (request.type !== "stream.subscribe") {
          return;
        }

        queueMicrotask(() => {
          socket.serverMessage({
            type: "stream-event",
            event: {
              type: "start",
              conversationId: "c-1",
              messageId: "a-1",
              timestamp: new Date().toISOString(),
            },
          });
          socket.serverMessage({
            type: "stream-event",
            event: {
              type: "delta",
              conversationId: "c-1",
              messageId: "a-1",
              delta: "hel",
              timestamp: new Date().toISOString(),
            },
          });
          socket.serverMessage({
            type: "stream-event",
            event: {
              type: "delta",
              conversationId: "c-1",
              messageId: "a-1",
              delta: "lo",
              timestamp: new Date().toISOString(),
            },
          });
          socket.serverMessage({
            type: "stream-event",
            event: {
              type: "complete",
              conversationId: "c-1",
              messageId: "a-1",
              content: "hello",
              timestamp: new Date().toISOString(),
            },
          });
        });
      });

    const code = await runOneshot(
      "hello there",
      { model: "gpt-4o-mini" },
      {
        fetchImpl,
        webSocketFactory,
        stdout,
        stderrWrite: (text) => {
          stderr.push(text);
        },
      },
    );

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.writes).toEqual(["hel", "lo", "\n"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.endsWith("/messages")).toBe(true);
    expect(requests[0]?.body).toEqual({ content: "hello there", model: "gpt-4o-mini" });
  });

  it("supports --no-stream by printing final response only", async () => {
    const stdout = new FakeStdout();

    const fetchImpl: typeof fetch = async () =>
      createJsonResponse({
        conversationId: "c-2",
        assistantMessageId: "a-2",
      });

    const webSocketFactory = () =>
      new FakeWebSocket((socket, payload) => {
        const request = JSON.parse(payload) as { type: string };
        if (request.type !== "stream.subscribe") {
          return;
        }

        queueMicrotask(() => {
          socket.serverMessage({
            type: "stream-event",
            event: {
              type: "complete",
              conversationId: "c-2",
              messageId: "a-2",
              content: "full response",
              timestamp: new Date().toISOString(),
            },
          });
        });
      });

    const code = await runOneshot("buffer this", { stream: false }, { fetchImpl, webSocketFactory, stdout });
    expect(code).toBe(0);
    expect(stdout.writes).toEqual(["full response", "\n"]);
  });

  it("returns exit code 1 when daemon is offline", async () => {
    const stdout = new FakeStdout();
    const stderr: string[] = [];

    const fetchImpl: typeof fetch = async () => {
      throw new Error("connect ECONNREFUSED");
    };

    const code = await runOneshot("hi", undefined, {
      fetchImpl,
      webSocketFactory: () => new FakeWebSocket(() => {}),
      stdout,
      stderrWrite: (text) => {
        stderr.push(text);
      },
    });

    expect(code).toBe(1);
    expect(stdout.writes).toEqual([]);
    expect(stderr.join("")).toContain("Daemon is not running");
  });

  it("returns exit code 1 with partial output when stream is interrupted", async () => {
    const stdout = new FakeStdout();
    const stderr: string[] = [];

    const fetchImpl: typeof fetch = async () =>
      createJsonResponse({
        conversationId: "c-3",
        assistantMessageId: "a-3",
      });

    const webSocketFactory = () =>
      new FakeWebSocket((socket, payload) => {
        const request = JSON.parse(payload) as { type: string };
        if (request.type !== "stream.subscribe") {
          return;
        }

        queueMicrotask(() => {
          socket.serverMessage({
            type: "stream-event",
            event: {
              type: "delta",
              conversationId: "c-3",
              messageId: "a-3",
              delta: "partial",
              timestamp: new Date().toISOString(),
            },
          });
          socket.serverClose(1011, "server error");
        });
      });

    const code = await runOneshot("interrupt me", undefined, {
      fetchImpl,
      webSocketFactory,
      stdout,
      stderrWrite: (text) => {
        stderr.push(text);
      },
    });

    expect(code).toBe(1);
    expect(stdout.writes).toEqual(["partial"]);
    expect(stderr.join("")).toContain("interrupted");
  });

  it("returns exit code 1 on timeout", async () => {
    const stderr: string[] = [];

    const fetchImpl: typeof fetch = async () =>
      createJsonResponse({
        conversationId: "c-4",
        assistantMessageId: "a-4",
      });

    const code = await runOneshot("wait forever", { timeoutSeconds: 0.01 }, {
      fetchImpl,
      webSocketFactory: () => new FakeWebSocket(() => {}),
      stderrWrite: (text) => {
        stderr.push(text);
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("Timed out");
  });

  it("returns exit code 1 on provider error event", async () => {
    const stderr: string[] = [];

    const fetchImpl: typeof fetch = async () =>
      createJsonResponse({
        conversationId: "c-5",
        assistantMessageId: "a-5",
      });

    const webSocketFactory = () =>
      new FakeWebSocket((socket, payload) => {
        const request = JSON.parse(payload) as { type: string };
        if (request.type !== "stream.subscribe") {
          return;
        }

        queueMicrotask(() => {
          socket.serverMessage({
            type: "stream-event",
            event: {
              type: "error",
              conversationId: "c-5",
              messageId: "a-5",
              error: { message: "provider failed" },
              timestamp: new Date().toISOString(),
            },
          });
        });
      });

    const code = await runOneshot("fail", undefined, {
      fetchImpl,
      webSocketFactory,
      stderrWrite: (text) => {
        stderr.push(text);
      },
    });

    expect(code).toBe(1);
    expect(stderr.join("")).toContain("provider failed");
  });
});

describe("oneshot argument parsing", () => {
  it("parses one-shot options and query", () => {
    expect(routeCliArgs(["--model", "gpt-4o-mini", "--timeout", "30", "--no-stream", "hello"]))
      .toEqual({ kind: "oneshot", query: "hello", options: { model: "gpt-4o-mini", timeoutSeconds: 30, stream: false } });
  });

  it("falls back to launch mode for unknown leading flags", () => {
    expect(routeCliArgs(["--unknown"])).toEqual({ kind: "launch-tui" });
  });
});
