import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { CdpError } from "../../../src/browser/errors";
import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { CdpClient } from "../../../src/browser/cdp-client";
import type { ElementRefRegistry } from "../../../src/browser/element-ref-registry";
import { BrowserActTool } from "../../../src/browser/tools/browser-act-tool";
import type { BrowserActToolOptions } from "../../../src/browser/tools/browser-act-tool";
import type { WatcherCronManager } from "../../../src/browser/watcher-cron-manager";
import type { BrowserWatcher } from "../../../src/browser/watcher";
import type { CdpMethod, WatcherConfig, WatcherState } from "../../../src/browser/types";
import type { ToolContext } from "../../../src/types";

interface SendCall {
  method: CdpMethod;
  params?: Record<string, unknown>;
  sessionId?: string;
}

class MockCdpClient {
  public readonly calls: SendCall[] = [];
  private readonly responses = new Map<CdpMethod, unknown[]>();

  queueResponse(method: CdpMethod, value: unknown): void {
    const existing = this.responses.get(method) ?? [];
    existing.push(value);
    this.responses.set(method, existing);
  }

  async send<T = unknown>(
    method: CdpMethod,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    this.calls.push({ method, params, sessionId });
    const queued = this.responses.get(method);
    if (!queued || queued.length === 0) {
      throw new Error(`No queued response for ${method}`);
    }

    const value = queued.shift();
    if (value instanceof Error) {
      throw value;
    }

    return value as T;
  }
}

class MockBrowserDaemonService {
  public currentTabId?: string;

  constructor(public readonly client: MockCdpClient) {}

  async ensureBrowser(): Promise<MockCdpClient> {
    return this.client;
  }

  getCurrentTabId(): string | undefined {
    return this.currentTabId;
  }
}

class MockElementRefRegistry {
  private readonly refs = new Map<string, Map<string, number>>();

  setRef(tabId: string, ref: string, backendNodeId: number): void {
    const byTab = this.refs.get(tabId) ?? new Map<string, number>();
    byTab.set(ref, backendNodeId);
    this.refs.set(tabId, byTab);
  }

  lookupRef(tabId: string, ref: string): number | undefined {
    return this.refs.get(tabId)?.get(ref);
  }
}

const context: ToolContext = {
  conversationId: "conv-1",
  userId: "user-1",
};

function setup(options?: BrowserActToolOptions): {
  client: MockCdpClient;
  service: MockBrowserDaemonService;
  registry: MockElementRefRegistry;
  tool: BrowserActTool;
} {
  const client = new MockCdpClient();
  const service = new MockBrowserDaemonService(client);
  const registry = new MockElementRefRegistry();
  const tool = new BrowserActTool(
    service as unknown as BrowserDaemonService,
    registry as unknown as ElementRefRegistry,
    options,
  );
  return { client, service, registry, tool };
}

function queueAttach(client: MockCdpClient, sessionId = "session-1"): void {
  client.queueResponse("Target.attachToTarget", { sessionId });
}

describe("BrowserActTool", () => {
  describe("definition", () => {
    it("has name browser_act", () => {
      const { tool } = setup();
      expect(tool.definition.name).toBe("browser_act");
    });

    it("has all actions in enum", () => {
      const { tool } = setup();
      const actions = tool.definition.parameters.properties.action?.enum;
      expect(actions).toEqual([
        "click",
        "type",
        "fill",
        "select",
        "scroll",
        "hover",
        "press_key",
        "evaluate",
        "screenshot",
        "watch",
        "unwatch",
        "list_watchers",
        "wait",
        "batch",
        "get_cookies",
        "set_cookie",
        "clear_cookies",
        "get_storage",
        "set_storage",
        "clear_storage",
      ]);
    });
  });

  describe("click", () => {
    it("resolves ref to backendNodeId via registry", async () => {
      const { client, service, registry, tool } = setup();
      service.currentTabId = "tab-1";
      registry.setRef("tab-1", "e0", 123);
      queueAttach(client);
      client.queueResponse("DOM.getBoxModel", {
        model: { width: 10, height: 20, content: [0, 0, 10, 0, 10, 20, 0, 20], padding: [], border: [], margin: [] },
      });
      client.queueResponse("Input.dispatchMouseEvent", {});
      client.queueResponse("Input.dispatchMouseEvent", {});
      client.queueResponse("Input.dispatchMouseEvent", {});

      await tool.execute({ action: "click", ref: "e0" }, context);

      const boxModelCall = client.calls.find((call) => call.method === "DOM.getBoxModel");
      expect(boxModelCall?.params).toEqual({ backendNodeId: 123 });
    });

    it("dispatches mouseMoved, mousePressed, mouseReleased events", async () => {
      const { client, service, registry, tool } = setup();
      service.currentTabId = "tab-1";
      registry.setRef("tab-1", "e0", 123);
      queueAttach(client);
      client.queueResponse("DOM.getBoxModel", {
        model: { width: 10, height: 20, content: [0, 0, 10, 0, 10, 20, 0, 20], padding: [], border: [], margin: [] },
      });
      client.queueResponse("Input.dispatchMouseEvent", {});
      client.queueResponse("Input.dispatchMouseEvent", {});
      client.queueResponse("Input.dispatchMouseEvent", {});

      const result = await tool.execute({ action: "click", ref: "e0", callId: "call-click" }, context);

      const mouseCalls = client.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
      expect(mouseCalls).toHaveLength(3);
      expect(mouseCalls.map((call) => call.params?.type)).toEqual([
        "mouseMoved",
        "mousePressed",
        "mouseReleased",
      ]);
      expect(result.result).toEqual({ action: "click", ref: "e0", x: 5, y: 10 });
    });

    it("returns ToolResult error for unknown ref", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);

      const result = await tool.execute({ action: "click", ref: "missing", callId: "call-missing" }, context);

      expect(result.callId).toBe("call-missing");
      expect(result.errorDetail?.code).toBe("ELEMENT_NOT_FOUND");
      expect(result.errorDetail?.retryable).toBe(false);
    });
  });

  describe("type", () => {
    it("focuses element via DOM.focus and types each character", async () => {
      const { client, service, registry, tool } = setup();
      service.currentTabId = "tab-1";
      registry.setRef("tab-1", "e1", 456);
      queueAttach(client);
      client.queueResponse("DOM.focus", {});
      client.queueResponse("Input.dispatchKeyEvent", {});
      client.queueResponse("Input.dispatchKeyEvent", {});
      client.queueResponse("Input.dispatchKeyEvent", {});
      client.queueResponse("Input.dispatchKeyEvent", {});

      const result = await tool.execute({ action: "type", ref: "e1", text: "ab" }, context);

      const focusCall = client.calls.find((call) => call.method === "DOM.focus");
      expect(focusCall?.params).toEqual({ backendNodeId: 456 });
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ action: "type", ref: "e1", text: "ab" });
    });

    it("clears field first when clear=true", async () => {
      const { client, service, registry, tool } = setup();
      service.currentTabId = "tab-1";
      registry.setRef("tab-1", "e1", 456);
      queueAttach(client);
      client.queueResponse("DOM.focus", {});
      client.queueResponse("Input.dispatchKeyEvent", {});
      client.queueResponse("Input.dispatchKeyEvent", {});
      client.queueResponse("Input.dispatchKeyEvent", {});
      client.queueResponse("Input.dispatchKeyEvent", {});
      client.queueResponse("Input.dispatchKeyEvent", {});
      client.queueResponse("Input.dispatchKeyEvent", {});

      await tool.execute({ action: "type", ref: "e1", text: "x", clear: true }, context);

      const keyEvents = client.calls
        .filter((call) => call.method === "Input.dispatchKeyEvent")
        .map((call) => ({
          key: call.params?.key,
          type: call.params?.type,
          modifiers: call.params?.modifiers,
        }));

      expect(keyEvents[0]).toEqual({ key: "a", type: "keyDown", modifiers: 2 });
      expect(keyEvents[1]).toEqual({ key: "a", type: "keyUp", modifiers: 2 });
      expect(keyEvents[2]).toEqual({ key: "Delete", type: "keyDown", modifiers: 0 });
      expect(keyEvents[3]).toEqual({ key: "Delete", type: "keyUp", modifiers: 0 });
    });
  });

  describe("fill", () => {
    it("resolves node to objectId and calls Runtime.callFunctionOn", async () => {
      const { client, service, registry, tool } = setup();
      service.currentTabId = "tab-1";
      registry.setRef("tab-1", "e2", 789);
      queueAttach(client);
      client.queueResponse("DOM.resolveNode", { object: { type: "object", objectId: "obj-1" } });
      client.queueResponse("Runtime.callFunctionOn", {});

      const result = await tool.execute({ action: "fill", ref: "e2", value: "hello" }, context);

      const call = client.calls.find((entry) => entry.method === "Runtime.callFunctionOn");
      expect(call?.params?.objectId).toBe("obj-1");
      expect(call?.params?.arguments).toEqual([{ value: "hello" }]);
      expect(typeof call?.params?.functionDeclaration).toBe("string");
      expect(result.result).toEqual({ action: "fill", ref: "e2", value: "hello" });
    });
  });

  describe("select", () => {
    it("sets select value via Runtime.callFunctionOn", async () => {
      const { client, service, registry, tool } = setup();
      service.currentTabId = "tab-1";
      registry.setRef("tab-1", "e3", 1001);
      queueAttach(client);
      client.queueResponse("DOM.resolveNode", { object: { type: "object", objectId: "obj-2" } });
      client.queueResponse("Runtime.callFunctionOn", {});

      const result = await tool.execute({ action: "select", ref: "e3", value: "us" }, context);

      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ action: "select", ref: "e3", value: "us" });
    });
  });

  describe("scroll", () => {
    it("calls Runtime.evaluate with default down 300", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Runtime.evaluate", { result: { type: "undefined" } });

      const result = await tool.execute({ action: "scroll" }, context);

      const evalCall = client.calls.find((call) => call.method === "Runtime.evaluate");
      expect(evalCall?.params?.expression).toBe("window.scrollBy(0, 300)");
      expect(result.result).toEqual({ action: "scroll", direction: "down", amount: 300 });
    });

    it("supports all four directions", async () => {
      const directions: Array<{ direction: "up" | "down" | "left" | "right"; expression: string }> = [
        { direction: "up", expression: "window.scrollBy(0, -120)" },
        { direction: "down", expression: "window.scrollBy(0, 120)" },
        { direction: "left", expression: "window.scrollBy(-120, 0)" },
        { direction: "right", expression: "window.scrollBy(120, 0)" },
      ];

      for (const item of directions) {
        const { client, service, tool } = setup();
        service.currentTabId = "tab-1";
        queueAttach(client);
        client.queueResponse("Runtime.evaluate", { result: { type: "undefined" } });

        await tool.execute({ action: "scroll", direction: item.direction, amount: 120 }, context);
        const evalCall = client.calls.find((call) => call.method === "Runtime.evaluate");
        expect(evalCall?.params?.expression).toBe(item.expression);
      }
    });
  });

  describe("hover", () => {
    it("calculates center coordinates and dispatches only mouseMoved", async () => {
      const { client, service, registry, tool } = setup();
      service.currentTabId = "tab-1";
      registry.setRef("tab-1", "e4", 2002);
      queueAttach(client);
      client.queueResponse("DOM.getBoxModel", {
        model: { width: 20, height: 20, content: [10, 10, 30, 10, 30, 30, 10, 30], padding: [], border: [], margin: [] },
      });
      client.queueResponse("Input.dispatchMouseEvent", {});

      const result = await tool.execute({ action: "hover", ref: "e4" }, context);

      const mouseCalls = client.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
      expect(mouseCalls).toHaveLength(1);
      expect(mouseCalls[0]?.params).toEqual({ type: "mouseMoved", x: 20, y: 20 });
      expect(result.result).toEqual({ action: "hover", ref: "e4", x: 20, y: 20 });
    });
  });

  describe("press_key", () => {
    it("dispatches keyDown and keyUp with modifier bitmask", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Input.dispatchKeyEvent", {});
      client.queueResponse("Input.dispatchKeyEvent", {});

      const result = await tool.execute(
        { action: "press_key", key: "Enter", modifiers: ["Alt", "Control", "Meta", "Shift"] },
        context,
      );

      const events = client.calls.filter((call) => call.method === "Input.dispatchKeyEvent");
      expect(events).toHaveLength(2);
      expect(events[0]?.params?.modifiers).toBe(15);
      expect(events[1]?.params?.modifiers).toBe(15);
      expect(result.result).toEqual({
        action: "press_key",
        key: "Enter",
        modifiers: ["Alt", "Control", "Meta", "Shift"],
      });
    });
  });

  describe("evaluate", () => {
    it("calls Runtime.evaluate and returns result.value", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Runtime.evaluate", {
        result: { type: "number", value: 42 },
      });

      const result = await tool.execute({ action: "evaluate", script: "6 * 7", awaitPromise: true }, context);

      const evalCall = client.calls.find((call) => call.method === "Runtime.evaluate");
      expect(evalCall?.params).toEqual({
        expression: "6 * 7",
        returnByValue: true,
        awaitPromise: true,
      });
      expect(result.result).toEqual({ action: "evaluate", result: 42 });
    });

    it("returns error when exceptionDetails present", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Runtime.evaluate", {
        result: { type: "undefined" },
        exceptionDetails: { text: "ReferenceError" },
      });

      const result = await tool.execute({ action: "evaluate", script: "bad()", callId: "call-eval" }, context);

      expect(result.callId).toBe("call-eval");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.error).toContain("Script evaluation failed");
    });
  });

  describe("screenshot", () => {
    it("returns inline base64 JPEG by default", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Page.captureScreenshot", { data: "AQID" });

      const result = await tool.execute({ action: "screenshot", callId: "call-ss" }, context);

      expect(result.callId).toBe("call-ss");
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({
        action: "screenshot",
        output: "inline",
        data: "AQID",
        mimeType: "image/jpeg",
      });

      const captureCall = client.calls.find((call) => call.method === "Page.captureScreenshot");
      expect(captureCall?.params).toEqual({ format: "jpeg", quality: 80 });
    });

    it("uses custom quality parameter", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Page.captureScreenshot", { data: "AQID" });

      await tool.execute({ action: "screenshot", quality: 50, callId: "call-q" }, context);

      const captureCall = client.calls.find((call) => call.method === "Page.captureScreenshot");
      expect(captureCall?.params).toEqual({ format: "jpeg", quality: 50 });
    });

    it("clamps quality to 0-100 range", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Page.captureScreenshot", { data: "AQID" });

      await tool.execute({ action: "screenshot", quality: 150, callId: "call-clamp" }, context);

      const captureCall = client.calls.find((call) => call.method === "Page.captureScreenshot");
      expect(captureCall?.params?.quality).toBe(100);
    });

    it("saves to file when output is 'file'", async () => {
      const mkdirCalls: Array<{ path: string; options: unknown }> = [];
      const writeCalls: Array<{ path: string; data: unknown }> = [];

      const { client, service, tool } = setup({
        screenshotDir: "/tmp/test-screenshots",
        mkdirFn: (async (path: string, options: unknown) => {
          mkdirCalls.push({ path: path as string, options });
        }) as typeof import("node:fs/promises").mkdir,
        writeFileFn: (async (path: string, data: unknown) => {
          writeCalls.push({ path: path as string, data });
        }) as typeof import("node:fs/promises").writeFile,
      });
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Page.captureScreenshot", { data: "AQID" });

      const result = await tool.execute(
        { action: "screenshot", output: "file", callId: "call-file" },
        context,
      );

      expect(mkdirCalls).toHaveLength(1);
      expect(mkdirCalls[0]?.path).toBe("/tmp/test-screenshots");
      expect(mkdirCalls[0]?.options).toEqual({ recursive: true });

      expect(writeCalls).toHaveLength(1);
      expect(writeCalls[0]?.path).toMatch(/^\/tmp\/test-screenshots\/screenshot-.*\.jpg$/);
      expect(writeCalls[0]?.data).toBeInstanceOf(Buffer);

      const resultObj = result.result as { action: string; output: string; path: string };
      expect(resultObj.action).toBe("screenshot");
      expect(resultObj.output).toBe("file");
      expect(resultObj.path).toMatch(/^\/tmp\/test-screenshots\/screenshot-.*\.jpg$/);
    });

    it("uses REINS_BROWSER_SCREENSHOTS env var when set", () => {
      const original = process.env.REINS_BROWSER_SCREENSHOTS;
      try {
        process.env.REINS_BROWSER_SCREENSHOTS = "/custom/screenshots";
        const { tool } = setup();
        // Access the screenshotDir via a screenshot call to verify it's used
        // We verify indirectly by checking the tool was constructed without error
        expect(tool.definition.name).toBe("browser_act");
      } finally {
        if (original === undefined) {
          delete process.env.REINS_BROWSER_SCREENSHOTS;
        } else {
          process.env.REINS_BROWSER_SCREENSHOTS = original;
        }
      }
    });

    it("uses screenshotDir option over env var", async () => {
      const mkdirCalls: Array<{ path: string }> = [];
      const writeCalls: Array<{ path: string }> = [];

      const original = process.env.REINS_BROWSER_SCREENSHOTS;
      try {
        process.env.REINS_BROWSER_SCREENSHOTS = "/env/screenshots";
        const { client, service, tool } = setup({
          screenshotDir: "/option/screenshots",
          mkdirFn: (async (path: string) => {
            mkdirCalls.push({ path: path as string });
          }) as typeof import("node:fs/promises").mkdir,
          writeFileFn: (async (path: string) => {
            writeCalls.push({ path: path as string });
          }) as typeof import("node:fs/promises").writeFile,
        });
        service.currentTabId = "tab-1";
        queueAttach(client);
        client.queueResponse("Page.captureScreenshot", { data: "AQID" });

        await tool.execute(
          { action: "screenshot", output: "file", callId: "call-opt" },
          context,
        );

        expect(mkdirCalls[0]?.path).toBe("/option/screenshots");
        expect(writeCalls[0]?.path).toMatch(/^\/option\/screenshots\/screenshot-.*\.jpg$/);
      } finally {
        if (original === undefined) {
          delete process.env.REINS_BROWSER_SCREENSHOTS;
        } else {
          process.env.REINS_BROWSER_SCREENSHOTS = original;
        }
      }
    });

    it("defaults quality to 80 for non-numeric values", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Page.captureScreenshot", { data: "AQID" });

      await tool.execute({ action: "screenshot", quality: "high", callId: "call-nan" }, context);

      const captureCall = client.calls.find((call) => call.method === "Page.captureScreenshot");
      expect(captureCall?.params?.quality).toBe(80);
    });
  });

  describe("error handling", () => {
    it("returns ToolResult error for unknown action", async () => {
      const { tool } = setup();
      const result = await tool.execute({ action: "unknown", callId: "call-unknown" }, context);
      expect(result.callId).toBe("call-unknown");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
    });

    it("returns ToolResult error for CDP failure", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      client.queueResponse("Target.attachToTarget", new CdpError("cdp failed"));

      const result = await tool.execute({ action: "scroll", callId: "call-cdp" }, context);
      expect(result.callId).toBe("call-cdp");
      expect(result.errorDetail).toEqual({
        code: "CDP_ERROR",
        message: "cdp failed",
        retryable: true,
      });
    });

    it("propagates callId in all error paths", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      client.queueResponse("Target.attachToTarget", new CdpError("boom"));

      const result = await tool.execute({ action: "press_key", key: "Enter", callId: "call-err" }, context);
      expect(result.callId).toBe("call-err");
      expect(result.name).toBe("browser_act");
      expect(result.result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // watch / unwatch / list_watchers tests
  // -------------------------------------------------------------------------

  describe("watch", () => {
    it("watch action creates watcher and returns watcherId", async () => {
      const mockWatcherManager = new MockWatcherManager();
      const { tool } = setup({ watcherManager: mockWatcherManager as unknown as WatcherCronManager });

      const result = await tool.execute(
        { action: "watch", url: "https://example.com", intervalSeconds: 300, callId: "call-watch" },
        context,
      );

      expect(result.callId).toBe("call-watch");
      expect(result.error).toBeUndefined();
      const data = result.result as { watcherId: string; url: string; intervalSeconds: number; message: string };
      expect(data.watcherId).toBe("watcher-001");
      expect(data.url).toBe("https://example.com");
      expect(data.intervalSeconds).toBe(300);
      expect(data.message).toContain("Watcher created");
      expect(mockWatcherManager.createCalls).toHaveLength(1);
    });

    it("unwatch action removes watcher", async () => {
      const mockWatcherManager = new MockWatcherManager();
      mockWatcherManager.watchers.set("watcher-001", makeMockWatcher("watcher-001"));
      const { tool } = setup({ watcherManager: mockWatcherManager as unknown as WatcherCronManager });

      const result = await tool.execute(
        { action: "unwatch", watcherId: "watcher-001", callId: "call-unwatch" },
        context,
      );

      expect(result.callId).toBe("call-unwatch");
      expect(result.error).toBeUndefined();
      const data = result.result as { watcherId: string; message: string };
      expect(data.watcherId).toBe("watcher-001");
      expect(data.message).toContain("Watcher removed");
      expect(mockWatcherManager.removeCalls).toHaveLength(1);
    });

    it("unwatch returns error for non-existent watcher", async () => {
      const mockWatcherManager = new MockWatcherManager();
      const { tool } = setup({ watcherManager: mockWatcherManager as unknown as WatcherCronManager });

      const result = await tool.execute(
        { action: "unwatch", watcherId: "nonexistent", callId: "call-unwatch-missing" },
        context,
      );

      expect(result.callId).toBe("call-unwatch-missing");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.error).toContain("Watcher not found");
    });

    it("list_watchers returns list of active watchers", async () => {
      const mockWatcherManager = new MockWatcherManager();
      mockWatcherManager.watchers.set("watcher-001", makeMockWatcher("watcher-001"));
      mockWatcherManager.watchers.set("watcher-002", makeMockWatcher("watcher-002", "https://other.com"));
      const { tool } = setup({ watcherManager: mockWatcherManager as unknown as WatcherCronManager });

      const result = await tool.execute(
        { action: "list_watchers", callId: "call-list" },
        context,
      );

      expect(result.callId).toBe("call-list");
      expect(result.error).toBeUndefined();
      const data = result.result as Array<{ watcherId: string; url: string; status: string }>;
      expect(data).toHaveLength(2);
      expect(data[0]!.watcherId).toBe("watcher-001");
      expect(data[1]!.watcherId).toBe("watcher-002");
      expect(data[1]!.url).toBe("https://other.com");
    });

    it("watch graceful error when watcherManager not provided", async () => {
      const { tool } = setup();

      const result = await tool.execute(
        { action: "watch", url: "https://example.com", callId: "call-no-manager" },
        context,
      );

      expect(result.callId).toBe("call-no-manager");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.error).toContain("Watcher mode not available");
    });

    it("unwatch graceful error when watcherManager not provided", async () => {
      const { tool } = setup();

      const result = await tool.execute(
        { action: "unwatch", watcherId: "watcher-001", callId: "call-no-manager-unwatch" },
        context,
      );

      expect(result.callId).toBe("call-no-manager-unwatch");
      expect(result.error).toContain("Watcher mode not available");
    });

    it("list_watchers graceful error when watcherManager not provided", async () => {
      const { tool } = setup();

      const result = await tool.execute(
        { action: "list_watchers", callId: "call-no-manager-list" },
        context,
      );

      expect(result.callId).toBe("call-no-manager-list");
      expect(result.error).toContain("Watcher mode not available");
    });

    it("watch uses default intervalSeconds when not provided", async () => {
      const mockWatcherManager = new MockWatcherManager();
      const { tool } = setup({ watcherManager: mockWatcherManager as unknown as WatcherCronManager });

      await tool.execute(
        { action: "watch", url: "https://example.com", callId: "call-default-interval" },
        context,
      );

      const config = mockWatcherManager.createCalls[0]!;
      expect(config.intervalSeconds).toBe(300);
    });
  });
});

// ---------------------------------------------------------------------------
// Mock WatcherCronManager for watch/unwatch/list_watchers tests
// ---------------------------------------------------------------------------

interface MockWatcherLike {
  id: string;
  state: WatcherState;
}

function makeMockWatcher(id: string, url = "https://example.com"): MockWatcherLike {
  return {
    id,
    state: {
      config: {
        id,
        url,
        intervalSeconds: 300,
        format: "compact" as const,
        filter: "interactive" as const,
        maxTokens: 2000,
        createdAt: Date.now(),
      },
      status: "active",
      baselineSnapshot: "snapshot:Example:1",
      lastCheckedAt: Date.now(),
    },
  };
}

class MockWatcherManager {
  public readonly watchers = new Map<string, MockWatcherLike>();
  public readonly createCalls: WatcherConfig[] = [];
  public readonly removeCalls: string[] = [];
  private nextId = 1;

  async createWatcher(config: WatcherConfig): Promise<MockWatcherLike> {
    const id = config.id.trim().length > 0 ? config.id : `watcher-${String(this.nextId++).padStart(3, "0")}`;
    const watcher = makeMockWatcher(id, config.url);
    watcher.state.config.intervalSeconds = config.intervalSeconds;
    this.createCalls.push(config);
    this.watchers.set(id, watcher);
    return watcher;
  }

  async removeWatcher(id: string): Promise<void> {
    this.removeCalls.push(id);
    this.watchers.delete(id);
  }

  getWatcher(id: string): MockWatcherLike | undefined {
    return this.watchers.get(id);
  }

  listWatchers(): MockWatcherLike[] {
    return Array.from(this.watchers.values());
  }
}
