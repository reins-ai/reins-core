import { describe, expect, it } from "bun:test";

import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { ElementRefRegistry } from "../../../src/browser/element-ref-registry";
import type { SnapshotEngine } from "../../../src/browser/snapshot";
import { BrowserActTool } from "../../../src/browser/tools/browser-act-tool";
import type { BrowserActToolOptions } from "../../../src/browser/tools/browser-act-tool";
import type { CdpMethod, Snapshot } from "../../../src/browser/types";
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

interface MockRefInfo {
  ref: string;
  backendNodeId: number;
  role: string;
  name?: string;
  value?: string;
  depth: number;
}

class MockElementRefRegistry {
  private readonly refs = new Map<string, Map<string, number>>();
  private readonly refInfos = new Map<string, Map<string, MockRefInfo>>();

  setRef(tabId: string, ref: string, backendNodeId: number): void {
    const byTab = this.refs.get(tabId) ?? new Map<string, number>();
    byTab.set(ref, backendNodeId);
    this.refs.set(tabId, byTab);
  }

  setRefInfo(tabId: string, ref: string, role: string, name?: string): void {
    const byTab = this.refInfos.get(tabId) ?? new Map<string, MockRefInfo>();
    byTab.set(ref, { ref, backendNodeId: -1, role, name, depth: 0 });
    this.refInfos.set(tabId, byTab);
  }

  lookupRef(tabId: string, ref: string): number | undefined {
    return this.refs.get(tabId)?.get(ref);
  }

  lookupRefInfo(tabId: string, ref: string): MockRefInfo | undefined {
    return this.refInfos.get(tabId)?.get(ref);
  }
}

class MockSnapshotEngine {
  public takeSnapshotCalls = 0;
  private snapshotToReturn: Snapshot | null = null;
  private shouldThrow = false;

  setSnapshot(snapshot: Snapshot): void {
    this.snapshotToReturn = snapshot;
  }

  setThrow(): void {
    this.shouldThrow = true;
  }

  async takeSnapshot(): Promise<Snapshot> {
    this.takeSnapshotCalls++;
    if (this.shouldThrow) {
      throw new Error("snapshot failed");
    }
    if (this.snapshotToReturn === null) {
      throw new Error("no snapshot configured");
    }
    return this.snapshotToReturn;
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

const context: ToolContext = {
  conversationId: "conv-1",
  userId: "user-1",
};

function setup(options?: BrowserActToolOptions): {
  client: MockCdpClient;
  service: MockBrowserDaemonService;
  registry: MockElementRefRegistry;
  snapshotEngine: MockSnapshotEngine;
  tool: BrowserActTool;
} {
  const client = new MockCdpClient();
  const service = new MockBrowserDaemonService(client);
  const registry = new MockElementRefRegistry();
  const snapshotEngine = new MockSnapshotEngine();
  const tool = new BrowserActTool(
    service as unknown as BrowserDaemonService,
    registry as unknown as ElementRefRegistry,
    {
      snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
      ...options,
    },
  );
  return { client, service, registry, snapshotEngine, tool };
}

function queueAttach(client: MockCdpClient, sessionId = "session-1"): void {
  client.queueResponse("Target.attachToTarget", { sessionId });
}

function makeSnapshot(nodes: Snapshot["nodes"]): Snapshot {
  return {
    tabId: "tab-1",
    url: "https://example.com",
    title: "Example",
    timestamp: Date.now(),
    nodes,
    format: "compact",
    tokenCount: 0,
    truncated: false,
  };
}

describe("BrowserActTool stale-ref recovery", () => {
  it("recovers stale ref by matching name and role, then retries with fresh ref", async () => {
    const { client, service, registry, snapshotEngine, tool } = setup();
    service.currentTabId = "tab-1";

    registry.setRefInfo("tab-1", "e0", "button", "Submit");
    registry.setRef("tab-1", "e5", 42);
    snapshotEngine.setSnapshot(
      makeSnapshot([{ ref: "e5", backendNodeId: 42, role: "button", name: "Submit", depth: 0 }]),
    );

    queueAttach(client);
    queueAttach(client);
    queueAttach(client);
    client.queueResponse("DOM.getBoxModel", {
      model: { width: 10, height: 20, content: [0, 0, 10, 0, 10, 20, 0, 20], padding: [], border: [], margin: [] },
    });
    client.queueResponse("Input.dispatchMouseEvent", {});
    client.queueResponse("Input.dispatchMouseEvent", {});
    client.queueResponse("Input.dispatchMouseEvent", {});

    const result = await tool.execute({ action: "click", ref: "e0", callId: "call-recover" }, context);

    expect(snapshotEngine.takeSnapshotCalls).toBe(1);
    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ action: "click", ref: "e5", x: 5, y: 10 });
  });

  it("propagates original ELEMENT_NOT_FOUND when snapshot has no matching node", async () => {
    const { client, service, registry, snapshotEngine, tool } = setup();
    service.currentTabId = "tab-1";

    registry.setRefInfo("tab-1", "e0", "button", "Submit");
    snapshotEngine.setSnapshot(
      makeSnapshot([{ ref: "e9", backendNodeId: 99, role: "button", name: "Cancel", depth: 0 }]),
    );

    queueAttach(client);
    queueAttach(client);

    const result = await tool.execute({ action: "click", ref: "e0", callId: "call-no-match" }, context);

    expect(snapshotEngine.takeSnapshotCalls).toBe(1);
    expect(result.errorDetail?.code).toBe("ELEMENT_NOT_FOUND");
    expect(result.error).toContain("Element not found for ref: e0");
  });

  it("prevents recursive recovery when retry still throws ElementNotFoundError", async () => {
    const { client, service, registry, snapshotEngine, tool } = setup();
    service.currentTabId = "tab-1";

    registry.setRefInfo("tab-1", "e0", "button", "Submit");
    snapshotEngine.setSnapshot(
      makeSnapshot([{ ref: "e5", backendNodeId: 42, role: "button", name: "Submit", depth: 0 }]),
    );

    queueAttach(client);
    queueAttach(client);
    queueAttach(client);

    const result = await tool.execute({ action: "click", ref: "e0", callId: "call-guard" }, context);

    expect(snapshotEngine.takeSnapshotCalls).toBe(1);
    expect(result.errorDetail?.code).toBe("ELEMENT_NOT_FOUND");
  });

  it("does not trigger recovery for non-ref actions", async () => {
    const { service, snapshotEngine, tool } = setup();
    service.currentTabId = "tab-1";

    const result = await tool.execute({ action: "evaluate", callId: "call-no-ref" }, context);

    expect(snapshotEngine.takeSnapshotCalls).toBe(0);
    expect(result.errorDetail?.code).toBe("BROWSER_ERROR");
  });

  it("propagates ElementNotFoundError immediately when no snapshot engine is configured", async () => {
    const client = new MockCdpClient();
    const service = new MockBrowserDaemonService(client);
    service.currentTabId = "tab-1";
    const registry = new MockElementRefRegistry();
    const tool = new BrowserActTool(
      service as unknown as BrowserDaemonService,
      registry as unknown as ElementRefRegistry,
    );

    queueAttach(client);

    const result = await tool.execute({ action: "click", ref: "missing", callId: "call-no-engine" }, context);

    expect(result.errorDetail?.code).toBe("ELEMENT_NOT_FOUND");
    expect(result.error).toContain("Element not found for ref: missing");
  });

  it("propagates original error when no ref info is available", async () => {
    const { client, service, snapshotEngine, tool } = setup();
    service.currentTabId = "tab-1";

    snapshotEngine.setSnapshot(
      makeSnapshot([{ ref: "e5", backendNodeId: 42, role: "button", name: "Submit", depth: 0 }]),
    );

    queueAttach(client);
    queueAttach(client);

    const result = await tool.execute({ action: "click", ref: "e0", callId: "call-no-info" }, context);

    expect(snapshotEngine.takeSnapshotCalls).toBe(0);
    expect(result.errorDetail?.code).toBe("ELEMENT_NOT_FOUND");
  });
});
