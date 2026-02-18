import { describe, expect, it } from "bun:test";

import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { CdpClient } from "../../../src/browser/cdp-client";
import type { ElementRefRegistry } from "../../../src/browser/element-ref-registry";
import { BrowserActTool } from "../../../src/browser/tools/browser-act-tool";
import type { BatchActionResult, CdpMethod } from "../../../src/browser/types";
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

function queueScrollSuccess(client: MockCdpClient): void {
  queueAttach(client);
  client.queueResponse("Runtime.evaluate", { result: { type: "undefined" } });
}

describe("BrowserActTool batch action", () => {
  it("returns empty results for empty actions array", async () => {
    const { tool } = setup();

    const result = await tool.execute(
      { action: "batch", actions: [], callId: "call-empty" },
      context,
    );

    expect(result.callId).toBe("call-empty");
    expect(result.error).toBeUndefined();
    const data = result.result as BatchActionResult;
    expect(data.completedCount).toBe(0);
    expect(data.results).toEqual([]);
    expect(data.error).toBeUndefined();
  });

  it("executes a single action batch successfully", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    queueScrollSuccess(client);

    const result = await tool.execute(
      {
        action: "batch",
        actions: [{ action: "scroll", direction: "down", amount: 100 }],
        callId: "call-single",
      },
      context,
    );

    expect(result.error).toBeUndefined();
    const data = result.result as BatchActionResult;
    expect(data.completedCount).toBe(1);
    expect(data.results).toHaveLength(1);
    expect(data.results[0]).toEqual({ action: "scroll", direction: "down", amount: 100 });
    expect(data.error).toBeUndefined();
  });

  it("executes multi-step batch with all steps succeeding", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";

    // Step 0: scroll down
    queueScrollSuccess(client);
    // Step 1: scroll up
    queueScrollSuccess(client);
    // Step 2: scroll right
    queueScrollSuccess(client);

    const result = await tool.execute(
      {
        action: "batch",
        actions: [
          { action: "scroll", direction: "down", amount: 100 },
          { action: "scroll", direction: "up", amount: 200 },
          { action: "scroll", direction: "right", amount: 50 },
        ],
        callId: "call-multi",
      },
      context,
    );

    expect(result.error).toBeUndefined();
    const data = result.result as BatchActionResult;
    expect(data.completedCount).toBe(3);
    expect(data.results).toHaveLength(3);
    expect(data.results[0]).toEqual({ action: "scroll", direction: "down", amount: 100 });
    expect(data.results[1]).toEqual({ action: "scroll", direction: "up", amount: 200 });
    expect(data.results[2]).toEqual({ action: "scroll", direction: "right", amount: 50 });
    expect(data.error).toBeUndefined();
  });

  it("stops on first error at step 1 and reports partial progress", async () => {
    const { client, service, registry, tool } = setup();
    service.currentTabId = "tab-1";

    // Step 0: scroll succeeds
    queueScrollSuccess(client);
    // Step 1: click on missing ref — will fail with ELEMENT_NOT_FOUND
    queueAttach(client);

    const result = await tool.execute(
      {
        action: "batch",
        actions: [
          { action: "scroll", direction: "down" },
          { action: "click", ref: "missing-ref" },
        ],
        callId: "call-stop-error",
      },
      context,
    );

    expect(result.error).toBeUndefined(); // batch itself succeeds, error is in result
    const data = result.result as BatchActionResult;
    expect(data.completedCount).toBe(1);
    expect(data.results).toHaveLength(1);
    expect(data.error).toBeDefined();
    expect(data.error!.step).toBe(1);
    expect(data.error!.code).toBe("ELEMENT_NOT_FOUND");
  });

  it("reports error at step 0 when first action fails", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";
    // click on missing ref — will fail immediately
    queueAttach(client);

    const result = await tool.execute(
      {
        action: "batch",
        actions: [
          { action: "click", ref: "nonexistent" },
        ],
        callId: "call-first-fail",
      },
      context,
    );

    const data = result.result as BatchActionResult;
    expect(data.completedCount).toBe(0);
    expect(data.results).toHaveLength(0);
    expect(data.error).toBeDefined();
    expect(data.error!.step).toBe(0);
    expect(data.error!.message).toContain("nonexistent");
  });

  it("error detail includes correct step index, message, and code", async () => {
    const { client, service, tool } = setup();
    service.currentTabId = "tab-1";

    // Step 0: scroll succeeds
    queueScrollSuccess(client);
    // Step 1: scroll succeeds
    queueScrollSuccess(client);
    // Step 2: click on missing ref — fails
    queueAttach(client);

    const result = await tool.execute(
      {
        action: "batch",
        actions: [
          { action: "scroll" },
          { action: "scroll" },
          { action: "click", ref: "bad-ref" },
        ],
        callId: "call-detail",
      },
      context,
    );

    const data = result.result as BatchActionResult;
    expect(data.completedCount).toBe(2);
    expect(data.results).toHaveLength(2);
    expect(data.error!.step).toBe(2);
    expect(data.error!.code).toBe("ELEMENT_NOT_FOUND");
    expect(typeof data.error!.message).toBe("string");
    expect(data.error!.message.length).toBeGreaterThan(0);
  });

  it("rejects nested batch actions", async () => {
    const { tool } = setup();

    const result = await tool.execute(
      {
        action: "batch",
        actions: [
          { action: "batch", actions: [{ action: "scroll" }] },
        ],
        callId: "call-nested",
      },
      context,
    );

    const data = result.result as BatchActionResult;
    expect(data.completedCount).toBe(0);
    expect(data.error).toBeDefined();
    expect(data.error!.step).toBe(0);
    expect(data.error!.message).toContain("Nested batch");
  });

  it("returns error result when actions is not an array", async () => {
    const { tool } = setup();

    const result = await tool.execute(
      { action: "batch", actions: "not-an-array", callId: "call-bad-actions" },
      context,
    );

    expect(result.callId).toBe("call-bad-actions");
    expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
    expect(result.error).toContain("array");
  });
});
