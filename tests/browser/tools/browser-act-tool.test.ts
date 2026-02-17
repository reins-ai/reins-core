import { describe, expect, it } from "bun:test";

import { CdpError } from "../../../src/browser/errors";
import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { CdpClient } from "../../../src/browser/cdp-client";
import type { ElementRefRegistry } from "../../../src/browser/element-ref-registry";
import { BrowserActTool } from "../../../src/browser/tools/browser-act-tool";
import type { CdpMethod } from "../../../src/browser/types";
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

function setup(): {
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

    it("has all 8 actions in enum", () => {
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
});
