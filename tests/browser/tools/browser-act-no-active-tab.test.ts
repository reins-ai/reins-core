import { describe, expect, it } from "bun:test";

import { BrowserActTool } from "../../../src/browser/tools/browser-act-tool";
import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { ElementRefRegistry } from "../../../src/browser/element-ref-registry";
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

describe("BrowserActTool no active tab fallback", () => {
  it("falls back to getFirstTabId when currentTabId is undefined", async () => {
    const client = new MockCdpClient();
    const service = new MockBrowserDaemonService(client);
    // currentTabId is undefined — triggers getFirstTabId fallback
    service.currentTabId = undefined;

    const refRegistry = new MockElementRefRegistry();
    refRegistry.setRef("tab-fallback", "e0", 42);

    // getFirstTabId calls Target.getTargets
    client.queueResponse("Target.getTargets", {
      targetInfos: [
        { targetId: "tab-fallback", type: "page", title: "Fallback", url: "https://example.com", attached: false },
      ],
    });
    // attachToTarget
    client.queueResponse("Target.attachToTarget", { sessionId: "session-fb" });
    // click resolves node
    client.queueResponse("DOM.resolveNode", {
      object: { objectId: "obj-1" },
    });
    client.queueResponse("DOM.getBoxModel", {
      model: { content: [10, 20, 30, 20, 30, 40, 10, 40], width: 20, height: 20, padding: [], border: [], margin: [] },
    });
    client.queueResponse("Input.dispatchMouseEvent", {}); // mouseMoved
    client.queueResponse("Input.dispatchMouseEvent", {}); // mousePressed
    client.queueResponse("Input.dispatchMouseEvent", {}); // mouseReleased

    const tool = new BrowserActTool(
      service as unknown as BrowserDaemonService,
      refRegistry as unknown as ElementRefRegistry,
    );

    const result = await tool.execute(
      { action: "click", ref: "e0" },
      context,
    );

    expect(result.error).toBeUndefined();

    // Verify Target.getTargets was called (the fallback path)
    const getTargetsCall = client.calls.find((c) => c.method === "Target.getTargets");
    expect(getTargetsCall).toBeDefined();
  });

  it("returns error when no tabs exist at all", async () => {
    const client = new MockCdpClient();
    const service = new MockBrowserDaemonService(client);
    service.currentTabId = undefined;

    // getFirstTabId returns no page targets
    client.queueResponse("Target.getTargets", {
      targetInfos: [
        { targetId: "sw-1", type: "service_worker", title: "SW", url: "", attached: false },
      ],
    });

    const refRegistry = new MockElementRefRegistry();

    const tool = new BrowserActTool(
      service as unknown as BrowserDaemonService,
      refRegistry as unknown as ElementRefRegistry,
    );

    const result = await tool.execute(
      { action: "click", ref: "e0" },
      context,
    );

    expect(result.error).toBeDefined();
    expect(result.error).toContain("No active tab");
  });
});
