import { describe, expect, it } from "bun:test";

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

function setup() {
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

describe("BrowserActTool wait action", () => {
  describe("ref_visible", () => {
    it("succeeds when element is in registry and has non-zero dimensions", async () => {
      const { client, service, registry, tool } = setup();
      service.currentTabId = "tab-1";
      registry.setRef("tab-1", "e0", 100);
      queueAttach(client);
      client.queueResponse("DOM.getBoxModel", {
        model: { width: 50, height: 30, content: [0, 0, 50, 0, 50, 30, 0, 30], padding: [], border: [], margin: [] },
      });

      const result = await tool.execute(
        { action: "wait", condition: "ref_visible", ref: "e0", timeout: 1000, callId: "call-rv" },
        context,
      );

      expect(result.callId).toBe("call-rv");
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ action: "wait", condition: "ref_visible", satisfied: true });
    });

    it("times out when element is not in registry", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      // Queue enough attach responses for polling iterations
      for (let i = 0; i < 10; i++) {
        queueAttach(client);
      }

      const result = await tool.execute(
        { action: "wait", condition: "ref_visible", ref: "e0", timeout: 50, callId: "call-rv-timeout" },
        context,
      );

      expect(result.callId).toBe("call-rv-timeout");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.error).toContain("timed out");
    });
  });

  describe("ref_present", () => {
    it("succeeds when element is in registry", async () => {
      const { client, service, registry, tool } = setup();
      service.currentTabId = "tab-1";
      registry.setRef("tab-1", "e1", 200);
      queueAttach(client);

      const result = await tool.execute(
        { action: "wait", condition: "ref_present", ref: "e1", timeout: 1000, callId: "call-rp" },
        context,
      );

      expect(result.callId).toBe("call-rp");
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ action: "wait", condition: "ref_present", satisfied: true });
    });

    it("times out when element is not in registry", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      for (let i = 0; i < 10; i++) {
        queueAttach(client);
      }

      const result = await tool.execute(
        { action: "wait", condition: "ref_present", ref: "e1", timeout: 50, callId: "call-rp-timeout" },
        context,
      );

      expect(result.callId).toBe("call-rp-timeout");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.error).toContain("timed out");
    });
  });

  describe("text_present", () => {
    it("succeeds when Runtime.evaluate returns true", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Runtime.evaluate", {
        result: { type: "boolean", value: true },
      });

      const result = await tool.execute(
        { action: "wait", condition: "text_present", text: "Hello", timeout: 1000, callId: "call-tp" },
        context,
      );

      expect(result.callId).toBe("call-tp");
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ action: "wait", condition: "text_present", satisfied: true });
    });

    it("times out when Runtime.evaluate returns false", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      for (let i = 0; i < 10; i++) {
        queueAttach(client);
        client.queueResponse("Runtime.evaluate", {
          result: { type: "boolean", value: false },
        });
      }

      const result = await tool.execute(
        { action: "wait", condition: "text_present", text: "Missing", timeout: 50, callId: "call-tp-timeout" },
        context,
      );

      expect(result.callId).toBe("call-tp-timeout");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.error).toContain("timed out");
    });
  });

  describe("load_state", () => {
    it("succeeds when readyState is 'complete' for complete condition", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Runtime.evaluate", {
        result: { type: "string", value: "complete" },
      });

      const result = await tool.execute(
        { action: "wait", condition: "load_state", state: "complete", timeout: 1000, callId: "call-ls-c" },
        context,
      );

      expect(result.callId).toBe("call-ls-c");
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ action: "wait", condition: "load_state", satisfied: true });
    });

    it("succeeds when readyState is 'interactive' for interactive condition", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);
      client.queueResponse("Runtime.evaluate", {
        result: { type: "string", value: "interactive" },
      });

      const result = await tool.execute(
        { action: "wait", condition: "load_state", state: "interactive", timeout: 1000, callId: "call-ls-i" },
        context,
      );

      expect(result.callId).toBe("call-ls-i");
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ action: "wait", condition: "load_state", satisfied: true });
    });

    it("times out when readyState is 'loading' for complete condition", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      for (let i = 0; i < 10; i++) {
        queueAttach(client);
        client.queueResponse("Runtime.evaluate", {
          result: { type: "string", value: "loading" },
        });
      }

      const result = await tool.execute(
        { action: "wait", condition: "load_state", state: "complete", timeout: 50, callId: "call-ls-timeout" },
        context,
      );

      expect(result.callId).toBe("call-ls-timeout");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.error).toContain("timed out");
    });
  });

  describe("custom timeout", () => {
    it("respects custom timeout value", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      for (let i = 0; i < 10; i++) {
        queueAttach(client);
      }

      const start = Date.now();
      await tool.execute(
        { action: "wait", condition: "ref_present", ref: "missing", timeout: 50, callId: "call-custom-timeout" },
        context,
      );
      const elapsed = Date.now() - start;

      // Should complete within a reasonable range of the 50ms timeout
      // Allow some slack for polling interval and execution overhead
      expect(elapsed).toBeLessThan(500);
      expect(elapsed).toBeGreaterThanOrEqual(40);
    });
  });

  describe("error handling", () => {
    it("returns error when condition param is missing", async () => {
      const { tool } = setup();

      const result = await tool.execute(
        { action: "wait", timeout: 100, callId: "call-no-condition" },
        context,
      );

      expect(result.callId).toBe("call-no-condition");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.error).toContain("condition");
    });

    it("returns error when ref is missing for ref_visible condition", async () => {
      const { client, service, tool } = setup();
      service.currentTabId = "tab-1";
      queueAttach(client);

      const result = await tool.execute(
        { action: "wait", condition: "ref_visible", timeout: 100, callId: "call-no-ref" },
        context,
      );

      expect(result.callId).toBe("call-no-ref");
      expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
      expect(result.error).toContain("ref");
    });
  });
});
