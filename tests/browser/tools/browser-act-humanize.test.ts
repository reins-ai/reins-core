import { describe, expect, it } from "bun:test";

import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { ElementRefRegistry } from "../../../src/browser/element-ref-registry";
import { BrowserActTool } from "../../../src/browser/tools/browser-act-tool";
import type { BrowserActToolOptions } from "../../../src/browser/tools/browser-act-tool";
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

function setupWithHumanize(
  randomValues: number[] = [0.5],
  options?: Partial<BrowserActToolOptions>,
): {
  client: MockCdpClient;
  service: MockBrowserDaemonService;
  registry: MockElementRefRegistry;
  tool: BrowserActTool;
  delays: number[];
} {
  const delays: number[] = [];
  const client = new MockCdpClient();
  const service = new MockBrowserDaemonService(client);
  const registry = new MockElementRefRegistry();

  let randomIdx = 0;
  const delayFn = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  const randomFn = (min: number, max: number): number => {
    const value = randomValues[randomIdx % randomValues.length] ?? 0.5;
    randomIdx++;
    return min + value * (max - min);
  };

  const tool = new BrowserActTool(
    service as unknown as BrowserDaemonService,
    registry as unknown as ElementRefRegistry,
    {
      delayFn,
      randomFn,
      ...options,
    },
  );

  return { client, service, registry, tool, delays };
}

function queueAttach(client: MockCdpClient): void {
  client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });
}

function queueMouseResponses(client: MockCdpClient, count: number): void {
  for (let i = 0; i < count; i++) {
    client.queueResponse("Input.dispatchMouseEvent", {});
  }
}

describe("BrowserActTool humanized interaction", () => {
  it("adds per-keystroke delays when type uses humanize=true", async () => {
    const { client, service, registry, tool, delays } = setupWithHumanize([0.25, 0.75]);
    service.currentTabId = "tab-1";
    registry.setRef("tab-1", "e1", 456);

    queueAttach(client);
    client.queueResponse("DOM.focus", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});

    const result = await tool.execute({ action: "type", ref: "e1", text: "ab", humanize: true }, context);

    expect(result.error).toBeUndefined();
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBe(60);
    expect(delays[1]).toBe(100);
  });

  it("does not delay typing when humanize is false", async () => {
    const { client, service, registry, tool, delays } = setupWithHumanize([0.5]);
    service.currentTabId = "tab-1";
    registry.setRef("tab-1", "e1", 456);

    queueAttach(client);
    client.queueResponse("DOM.focus", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});

    await tool.execute({ action: "type", ref: "e1", text: "ab" }, context);

    expect(delays).toHaveLength(0);
  });

  it("emits intermediate mouseMoved events when click uses humanize=true", async () => {
    const { client, service, registry, tool } = setupWithHumanize([0.5]);
    service.currentTabId = "tab-1";
    registry.setRef("tab-1", "e0", 123);

    queueAttach(client);
    client.queueResponse("DOM.getBoxModel", {
      model: { width: 10, height: 20, content: [0, 0, 10, 0, 10, 20, 0, 20], padding: [], border: [], margin: [] },
    });
    queueMouseResponses(client, 11);

    await tool.execute({ action: "click", ref: "e0", humanize: true }, context);

    const mouseCalls = client.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
    const movedCalls = mouseCalls.filter((call) => call.params?.type === "mouseMoved");

    expect(mouseCalls).toHaveLength(11);
    expect(movedCalls.length).toBeGreaterThan(1);
    expect(movedCalls).toHaveLength(9);
  });

  it("keeps standard single mouse move when click humanize is false", async () => {
    const { client, service, registry, tool } = setupWithHumanize([0.5]);
    service.currentTabId = "tab-1";
    registry.setRef("tab-1", "e0", 123);

    queueAttach(client);
    client.queueResponse("DOM.getBoxModel", {
      model: { width: 10, height: 20, content: [0, 0, 10, 0, 10, 20, 0, 20], padding: [], border: [], margin: [] },
    });
    queueMouseResponses(client, 3);

    await tool.execute({ action: "click", ref: "e0" }, context);

    const movedCalls = client.calls.filter(
      (call) => call.method === "Input.dispatchMouseEvent" && call.params?.type === "mouseMoved",
    );
    expect(movedCalls).toHaveLength(1);
  });

  it("uses injectable randomFn values for deterministic typing delay", async () => {
    const { client, service, registry, tool, delays } = setupWithHumanize([0.5]);
    service.currentTabId = "tab-1";
    registry.setRef("tab-1", "e2", 789);

    queueAttach(client);
    client.queueResponse("DOM.focus", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});

    await tool.execute({ action: "type", ref: "e2", text: "ab", humanize: true }, context);

    expect(delays).toEqual([80, 80]);
  });

  it("calls delayFn with values in default typing range", async () => {
    const delays: number[] = [];
    const client = new MockCdpClient();
    const service = new MockBrowserDaemonService(client);
    service.currentTabId = "tab-1";
    const registry = new MockElementRefRegistry();
    registry.setRef("tab-1", "e4", 1001);

    const tool = new BrowserActTool(
      service as unknown as BrowserDaemonService,
      registry as unknown as ElementRefRegistry,
      {
        delayFn: async (ms: number) => {
          delays.push(ms);
        },
      },
    );

    queueAttach(client);
    client.queueResponse("DOM.focus", {});
    client.queueResponse("Input.dispatchKeyEvent", {});
    client.queueResponse("Input.dispatchKeyEvent", {});

    await tool.execute({ action: "type", ref: "e4", text: "a", humanize: true }, context);

    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(40);
    expect(delays[0]).toBeLessThanOrEqual(120);
  });

  it("generates at least eight intermediate points before click events", async () => {
    const { client, service, registry, tool } = setupWithHumanize([0.5]);
    service.currentTabId = "tab-1";
    registry.setRef("tab-1", "e0", 123);

    queueAttach(client);
    client.queueResponse("DOM.getBoxModel", {
      model: { width: 10, height: 20, content: [0, 0, 10, 0, 10, 20, 0, 20], padding: [], border: [], margin: [] },
    });
    queueMouseResponses(client, 11);

    await tool.execute({ action: "click", ref: "e0", humanize: true }, context);

    const mouseCalls = client.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
    const pressIndex = mouseCalls.findIndex((call) => call.params?.type === "mousePressed");
    const movedBeforePress = mouseCalls
      .slice(0, pressIndex)
      .filter((call) => call.params?.type === "mouseMoved");

    expect(pressIndex).toBeGreaterThan(0);
    expect(movedBeforePress.length).toBeGreaterThanOrEqual(8);
  });
});
