import { describe, expect, it } from "bun:test";
import { DebugEventBuffer } from "../../src/browser/debug-event-buffer";

type CdpEventListener = (params: Record<string, unknown>) => void;

class MockCdpClient {
  public readonly sendCalls: Array<{
    method: string;
    params?: Record<string, unknown>;
    sessionId?: string;
  }> = [];
  private readonly eventListeners = new Map<string, Set<CdpEventListener>>();

  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<unknown> {
    this.sendCalls.push({ method, params, sessionId });
    return {};
  }

  on(event: string, listener: CdpEventListener): () => void {
    let listeners = this.eventListeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.eventListeners.set(event, listeners);
    }
    listeners.add(listener);
    return () => {
      this.eventListeners.get(event)?.delete(listener);
    };
  }

  emit(event: string, params: Record<string, unknown>): void {
    this.eventListeners.get(event)?.forEach((listener) => listener(params));
  }

  listenerCount(event: string): number {
    return this.eventListeners.get(event)?.size ?? 0;
  }
}

describe("DebugEventBuffer", () => {
  function setup() {
    const client = new MockCdpClient();
    const buffer = new DebugEventBuffer();
    return { client, buffer };
  }

  describe("subscribe", () => {
    it("enables Console, Runtime, and Network CDP domains", async () => {
      const { client, buffer } = setup();

      buffer.subscribe(client as never, "session-1");

      // Allow fire-and-forget sends to resolve
      await new Promise((r) => setTimeout(r, 10));

      const methods = client.sendCalls.map((c) => c.method);
      expect(methods).toContain("Console.enable");
      expect(methods).toContain("Runtime.enable");
      expect(methods).toContain("Network.enable");
    });

    it("passes sessionId to domain enable calls", async () => {
      const { client, buffer } = setup();

      buffer.subscribe(client as never, "session-42");

      await new Promise((r) => setTimeout(r, 10));

      for (const call of client.sendCalls) {
        expect(call.sessionId).toBe("session-42");
      }
    });
  });

  describe("console events", () => {
    it("captures Console.messageAdded events", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      client.emit("Console.messageAdded", {
        message: { level: "log", text: "hello world", timestamp: 1000 },
      });

      const entries = buffer.getConsole();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        level: "log",
        text: "hello world",
        timestamp: 1000,
      });
    });
  });

  describe("page error events", () => {
    it("captures Runtime.exceptionThrown events", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      client.emit("Runtime.exceptionThrown", {
        exceptionDetails: {
          text: "Uncaught TypeError: x is not a function",
          stackTrace: { callFrames: [] },
        },
      });

      const errors = buffer.getErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe(
        "Uncaught TypeError: x is not a function",
      );
      expect(errors[0].stack).toBe(JSON.stringify({ callFrames: [] }));
    });

    it("handles errors without stackTrace", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      client.emit("Runtime.exceptionThrown", {
        exceptionDetails: { text: "Script error." },
      });

      const errors = buffer.getErrors();
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toBe("Script error.");
      expect(errors[0].stack).toBeUndefined();
    });
  });

  describe("network events", () => {
    it("captures Network.responseReceived events", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      client.emit("Network.responseReceived", {
        response: { url: "https://example.com/api", status: 200 },
        requestId: "req-1",
      });

      const entries = buffer.getNetwork();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        url: "https://example.com/api",
        method: "GET",
        status: 200,
        failed: false,
      });
    });

    it("captures Network.loadingFailed events", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      client.emit("Network.loadingFailed", {
        url: "https://example.com/broken",
        requestId: "req-2",
        errorText: "net::ERR_CONNECTION_REFUSED",
      });

      const entries = buffer.getNetwork();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual({
        url: "https://example.com/broken",
        method: "GET",
        status: undefined,
        failed: true,
      });
    });
  });

  describe("navigation clear", () => {
    it("clears all buffers on Page.frameNavigated", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      client.emit("Console.messageAdded", {
        message: { level: "log", text: "before nav", timestamp: 1 },
      });
      client.emit("Runtime.exceptionThrown", {
        exceptionDetails: { text: "err" },
      });
      client.emit("Network.responseReceived", {
        response: { url: "https://a.com", status: 200 },
      });

      expect(buffer.getConsole()).toHaveLength(1);
      expect(buffer.getErrors()).toHaveLength(1);
      expect(buffer.getNetwork()).toHaveLength(1);

      client.emit("Page.frameNavigated", { frame: { id: "main" } });

      expect(buffer.getConsole()).toHaveLength(0);
      expect(buffer.getErrors()).toHaveLength(0);
      expect(buffer.getNetwork()).toHaveLength(0);
    });
  });

  describe("rolling buffer cap", () => {
    it("evicts oldest entry when buffer exceeds 100", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      for (let i = 0; i < 101; i++) {
        client.emit("Console.messageAdded", {
          message: { level: "log", text: `msg-${i}`, timestamp: i },
        });
      }

      const entries = buffer.getConsole();
      expect(entries).toHaveLength(100);
      expect(entries[0].text).toBe("msg-1");
      expect(entries[99].text).toBe("msg-100");
    });

    it("caps error buffer at 100 entries", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      for (let i = 0; i < 105; i++) {
        client.emit("Runtime.exceptionThrown", {
          exceptionDetails: { text: `error-${i}` },
        });
      }

      const errors = buffer.getErrors();
      expect(errors).toHaveLength(100);
      expect(errors[0].message).toBe("error-5");
    });

    it("caps network buffer at 100 entries", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      for (let i = 0; i < 103; i++) {
        client.emit("Network.responseReceived", {
          response: { url: `https://example.com/${i}`, status: 200 },
        });
      }

      const network = buffer.getNetwork();
      expect(network).toHaveLength(100);
      expect(network[0].url).toBe("https://example.com/3");
    });
  });

  describe("unsubscribe", () => {
    it("removes all event listeners", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      expect(client.listenerCount("Console.messageAdded")).toBe(1);
      expect(client.listenerCount("Runtime.exceptionThrown")).toBe(1);
      expect(client.listenerCount("Network.responseReceived")).toBe(1);
      expect(client.listenerCount("Network.loadingFailed")).toBe(1);
      expect(client.listenerCount("Page.frameNavigated")).toBe(1);

      buffer.unsubscribe();

      expect(client.listenerCount("Console.messageAdded")).toBe(0);
      expect(client.listenerCount("Runtime.exceptionThrown")).toBe(0);
      expect(client.listenerCount("Network.responseReceived")).toBe(0);
      expect(client.listenerCount("Network.loadingFailed")).toBe(0);
      expect(client.listenerCount("Page.frameNavigated")).toBe(0);
    });

    it("stops capturing events after unsubscribe", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      client.emit("Console.messageAdded", {
        message: { level: "log", text: "before", timestamp: 1 },
      });
      expect(buffer.getConsole()).toHaveLength(1);

      buffer.unsubscribe();

      client.emit("Console.messageAdded", {
        message: { level: "log", text: "after", timestamp: 2 },
      });
      expect(buffer.getConsole()).toHaveLength(1);
      expect(buffer.getConsole()[0].text).toBe("before");
    });
  });

  describe("getAll", () => {
    it("returns all three categories", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      client.emit("Console.messageAdded", {
        message: { level: "warn", text: "warning", timestamp: 100 },
      });
      client.emit("Runtime.exceptionThrown", {
        exceptionDetails: { text: "oops" },
      });
      client.emit("Network.responseReceived", {
        response: { url: "https://api.test", status: 404 },
      });

      const snapshot = buffer.getAll();
      expect(snapshot.console).toHaveLength(1);
      expect(snapshot.errors).toHaveLength(1);
      expect(snapshot.network).toHaveLength(1);
      expect(snapshot.console![0].text).toBe("warning");
      expect(snapshot.errors![0].message).toBe("oops");
      expect(snapshot.network![0].status).toBe(404);
    });

    it("returns copies that do not mutate internal state", () => {
      const { client, buffer } = setup();
      buffer.subscribe(client as never, "s1");

      client.emit("Console.messageAdded", {
        message: { level: "log", text: "test", timestamp: 1 },
      });

      const snapshot = buffer.getAll();
      snapshot.console!.length = 0;

      expect(buffer.getConsole()).toHaveLength(1);
    });
  });
});
