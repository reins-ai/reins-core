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

  public addEventListener(type: EventName, listener: unknown): void {
    const typed = listener as never;
    (this.listeners[type] as unknown[]).push(typed);
  }

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
    for (const listener of this.listeners.message) {
      listener({ data: JSON.stringify(payload) });
    }
  }

  public emitClose(code: number, reason: string): void {
    for (const listener of this.listeners.close) {
      listener({ code, reason });
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
    json: async () => ({ webSocketDebuggerUrl }),
  };
}

async function waitForSocketCount(sockets: MockWebSocket[], expectedCount: number): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (sockets.length >= expectedCount) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Expected at least ${expectedCount} sockets`);
}

describe("CdpClient extended coverage", () => {
  describe("isConnected getter", () => {
    it("returns false before connect", () => {
      const client = new CdpClient({
        port: 9222,
        fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/x"),
        webSocketFactory: (url: string) => new MockWebSocket(url),
      });

      expect(client.isConnected).toBe(false);
    });

    it("returns true after successful connect", async () => {
      const sockets: MockWebSocket[] = [];
      const client = new CdpClient({
        port: 9222,
        fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/x"),
        webSocketFactory: (url: string) => {
          const socket = new MockWebSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const connectPromise = client.connect();
      await waitForSocketCount(sockets, 1);
      sockets[0]!.emitOpen();
      await connectPromise;

      expect(client.isConnected).toBe(true);
    });
  });

  describe("sessionId getter", () => {
    it("returns undefined before any session is attached", () => {
      const client = new CdpClient({
        port: 9222,
        fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/x"),
        webSocketFactory: (url: string) => new MockWebSocket(url),
      });

      expect(client.sessionId).toBeUndefined();
    });
  });

  describe("disconnect", () => {
    it("closes socket and sets isConnected to false", async () => {
      const sockets: MockWebSocket[] = [];
      const client = new CdpClient({
        port: 9222,
        fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/disc"),
        webSocketFactory: (url: string) => {
          const socket = new MockWebSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const connectPromise = client.connect();
      await waitForSocketCount(sockets, 1);
      sockets[0]!.emitOpen();
      await connectPromise;

      expect(client.isConnected).toBe(true);

      await client.disconnect();

      expect(client.isConnected).toBe(false);
      expect(sockets[0]!.closedWith).toBeDefined();
      expect(sockets[0]!.closedWith?.code).toBe(1000);
    });

    it("rejects pending commands on disconnect", async () => {
      const sockets: MockWebSocket[] = [];
      const client = new CdpClient({
        port: 9222,
        fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/disc2"),
        webSocketFactory: (url: string) => {
          const socket = new MockWebSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const connectPromise = client.connect();
      await waitForSocketCount(sockets, 1);
      sockets[0]!.emitOpen();
      await connectPromise;

      const pending = client.send("Target.getTargets");

      await client.disconnect();

      await expect(pending).rejects.toBeInstanceOf(CdpError);
    });

    it("disconnect is idempotent when already disconnected", async () => {
      const client = new CdpClient({
        port: 9222,
        fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/idem"),
        webSocketFactory: (url: string) => new MockWebSocket(url),
      });

      // Should not throw even when never connected
      await client.disconnect();
      expect(client.isConnected).toBe(false);
    });
  });

  describe("connect idempotency", () => {
    it("connect is no-op when already connected", async () => {
      const sockets: MockWebSocket[] = [];
      const client = new CdpClient({
        port: 9222,
        fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/idem2"),
        webSocketFactory: (url: string) => {
          const socket = new MockWebSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const connectPromise = client.connect();
      await waitForSocketCount(sockets, 1);
      sockets[0]!.emitOpen();
      await connectPromise;

      // Second connect should be a no-op
      await client.connect();
      expect(sockets).toHaveLength(1);
    });
  });

  describe("connect error on WebSocket close before open", () => {
    it("rejects when socket closes before opening", async () => {
      const sockets: MockWebSocket[] = [];
      const client = new CdpClient({
        port: 9222,
        fetchFn: async () => createVersionResponse("ws://127.0.0.1:9222/devtools/browser/closeearly"),
        webSocketFactory: (url: string) => {
          const socket = new MockWebSocket(url);
          sockets.push(socket);
          return socket;
        },
      });

      const connectPromise = client.connect();
      await waitForSocketCount(sockets, 1);
      sockets[0]!.emitClose(1006, "closed before open");

      await expect(connectPromise).rejects.toBeInstanceOf(CdpError);
    });
  });
});
