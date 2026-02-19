import { describe, expect, it } from "bun:test";

import {
  BrowserNotRunningError,
  CdpError,
} from "../../../src/browser/errors";
import type { BrowserDaemonService } from "../../../src/browser/browser-daemon-service";
import type { SnapshotEngine, TakeSnapshotParams } from "../../../src/browser/snapshot";
import type { CdpMethod, Snapshot, SnapshotDiff } from "../../../src/browser/types";
import { BrowserSnapshotTool } from "../../../src/browser/tools/browser-snapshot-tool";
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

    const next = queued.shift();
    if (next instanceof Error) {
      throw next;
    }

    return next as T;
  }
}

function makeSnapshot(overrides?: Partial<Snapshot>): Snapshot {
  return {
    tabId: "tab-1",
    url: "https://example.com",
    title: "Example",
    timestamp: Date.now(),
    nodes: [
      { ref: "e0", backendNodeId: 1, role: "link", name: "Home", depth: 0 },
      { ref: "e1", backendNodeId: 2, role: "button", name: "Submit", depth: 0 },
    ],
    format: "text",
    tokenCount: 42,
    truncated: false,
    ...overrides,
  };
}

class MockSnapshotEngine {
  public takeSnapshotCalls: TakeSnapshotParams[] = [];
  public computeDiffCalls: Array<{ prev: Snapshot; current: Snapshot }> = [];
  public serializeSnapshotCalls: Array<{ snapshot: Snapshot; format: string }> = [];
  public serializeDiffCalls: Array<{ diff: SnapshotDiff; format: string }> = [];

  public snapshotToReturn: Snapshot = makeSnapshot();
  public lastSnapshotByTab = new Map<string, Snapshot>();
  public serializedOutput = "e0:link \"Home\"\ne1:button \"Submit\"";
  public serializedDiffOutput = "added:\n+ e2:button \"New\"\nchanged:\n~ (none)\nremoved:\n- (none)";
  public diffToReturn: SnapshotDiff = {
    added: [{ ref: "e2", backendNodeId: 3, role: "button", name: "New", depth: 0 }],
    changed: [],
    removed: [],
  };

  async takeSnapshot(params: TakeSnapshotParams): Promise<Snapshot> {
    this.takeSnapshotCalls.push(params);
    return this.snapshotToReturn;
  }

  getLastSnapshot(tabId: string): Snapshot | undefined {
    return this.lastSnapshotByTab.get(tabId);
  }

  computeDiff(prev: Snapshot, current: Snapshot): SnapshotDiff {
    this.computeDiffCalls.push({ prev, current });
    return this.diffToReturn;
  }

  serializeSnapshot(snapshot: Snapshot, format: string): string {
    this.serializeSnapshotCalls.push({ snapshot, format });
    return this.serializedOutput;
  }

  serializeDiff(diff: SnapshotDiff, format: string): string {
    this.serializeDiffCalls.push({ diff, format });
    return this.serializedDiffOutput;
  }
}

function makeMockService(
  client: MockCdpClient,
  options?: {
    currentTabId?: string;
    shouldThrowOnEnsure?: boolean;
    tabs?: Array<{ tabId: string; url: string; title: string; active: boolean }>;
  },
) {
  const tabs = options?.tabs ?? [
    { tabId: "tab-1", url: "https://example.com", title: "Example", active: true },
  ];

  return {
    ensureBrowser: async () => {
      if (options?.shouldThrowOnEnsure) {
        throw new BrowserNotRunningError("Browser unavailable");
      }
      return client;
    },
    getCurrentTabId: () => {
      if (options && "currentTabId" in options) {
        return options.currentTabId;
      }
      return "tab-1";
    },
    getStatus: () => ({
      running: true,
      tabs,
      activeTabId: options?.currentTabId ?? tabs[0]?.tabId,
      profilePath: "/mock/profile",
      headless: true,
    }),
    updateTabState: () => {},
  } as unknown as BrowserDaemonService;
}

const context: ToolContext = {
  conversationId: "conv-1",
  userId: "user-1",
};

describe("BrowserSnapshotTool", () => {
  it("has name browser_snapshot in tool definition", () => {
    const client = new MockCdpClient();
    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    expect(tool.definition.name).toBe("browser_snapshot");
  });

  it("execute with default args returns text format snapshot", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ callId: "call-1" }, context);

    expect(result.callId).toBe("call-1");
    expect(result.error).toBeUndefined();
    expect(result.name).toBe("browser_snapshot");

    const data = result.result as Record<string, unknown>;
    expect(data.content).toBe("e0:link \"Home\"\ne1:button \"Submit\"");
    expect(data.format).toBe("text");
    expect(data.tabId).toBe("tab-1");
    expect(data.url).toBe("https://example.com");
    expect(data.title).toBe("Example");
    expect(data.tokenCount).toBe(42);
    expect(data.truncated).toBe(false);

    expect(engine.takeSnapshotCalls).toHaveLength(1);
    const params = engine.takeSnapshotCalls[0]!;
    expect(params.tabId).toBe("tab-1");
    expect(params.sessionId).toBe("session-1");
    expect(params.options?.format).toBe("text");
    expect(params.options?.filter).toBe("none");
    expect(params.options?.diff).toBe(false);

    expect(engine.serializeSnapshotCalls).toHaveLength(1);
    expect(engine.serializeSnapshotCalls[0]!.format).toBe("text");
  });

  it("execute with format=compact returns compact format", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    engine.serializedOutput = "e0:link \"Home\"|e1:button \"Submit\"";
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ callId: "call-2", format: "compact" }, context);

    expect(result.error).toBeUndefined();
    const data = result.result as Record<string, unknown>;
    expect(data.format).toBe("compact");

    expect(engine.takeSnapshotCalls[0]!.options?.format).toBe("compact");
    expect(engine.serializeSnapshotCalls[0]!.format).toBe("compact");
  });

  it("execute with format=json returns json format", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    engine.serializedOutput = '[{"ref":"e0","role":"link"}]';
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ format: "json" }, context);

    expect(result.error).toBeUndefined();
    const data = result.result as Record<string, unknown>;
    expect(data.format).toBe("json");
    expect(data.content).toBe('[{"ref":"e0","role":"link"}]');

    expect(engine.takeSnapshotCalls[0]!.options?.format).toBe("json");
  });

  it("execute with filter=interactive applies filter", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ filter: "interactive" }, context);

    expect(result.error).toBeUndefined();
    expect(engine.takeSnapshotCalls[0]!.options?.filter).toBe("interactive");
  });

  it("execute with diff=true and no previous snapshot returns all nodes as added", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    // No previous snapshot stored for tab-1
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ diff: true }, context);

    expect(result.error).toBeUndefined();
    // Should call serializeDiff with all nodes as added
    expect(engine.serializeDiffCalls).toHaveLength(1);
    const diffArg = engine.serializeDiffCalls[0]!.diff;
    expect(diffArg.added).toHaveLength(2); // all snapshot nodes
    expect(diffArg.changed).toHaveLength(0);
    expect(diffArg.removed).toHaveLength(0);
    // Should NOT call computeDiff (no previous)
    expect(engine.computeDiffCalls).toHaveLength(0);
  });

  it("execute with diff=true and previous snapshot returns computed diff", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const previousSnapshot = makeSnapshot({ timestamp: Date.now() - 5000 });
    const engine = new MockSnapshotEngine();
    engine.lastSnapshotByTab.set("tab-1", previousSnapshot);

    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ diff: true }, context);

    expect(result.error).toBeUndefined();
    expect(engine.computeDiffCalls).toHaveLength(1);
    expect(engine.computeDiffCalls[0]!.prev).toBe(previousSnapshot);
    expect(engine.serializeDiffCalls).toHaveLength(1);

    const data = result.result as Record<string, unknown>;
    expect(data.content).toBe(engine.serializedDiffOutput);
  });

  it("execute with maxTokens passes value to snapshot engine", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    engine.snapshotToReturn = makeSnapshot({ truncated: true, tokenCount: 10 });
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ maxTokens: 10 }, context);

    expect(result.error).toBeUndefined();
    expect(engine.takeSnapshotCalls[0]!.options?.maxTokens).toBe(10);

    const data = result.result as Record<string, unknown>;
    expect(data.truncated).toBe(true);
    expect(data.tokenCount).toBe(10);
  });

  it("execute propagates callId", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ callId: "my-call-42" }, context);

    expect(result.callId).toBe("my-call-42");
  });

  it("execute defaults callId to unknown-call when not provided", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({}, context);

    expect(result.callId).toBe("unknown-call");
  });

  it("returns error result when browser is not running", async () => {
    const client = new MockCdpClient();
    const engine = new MockSnapshotEngine();
    const service = makeMockService(client, { shouldThrowOnEnsure: true });
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ callId: "call-err" }, context);

    expect(result.callId).toBe("call-err");
    expect(result.error).toBe("Browser unavailable");
    expect(result.result).toBeNull();
    expect(result.errorDetail).toEqual({
      code: "BROWSER_NOT_RUNNING",
      message: "Browser unavailable",
      retryable: false,
    });
  });

  it("returns error result when CDP fails", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", new CdpError("Connection lost", { cdpCode: -32000 }));

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({}, context);

    expect(result.error).toBe("Connection lost");
    expect(result.result).toBeNull();
    expect(result.errorDetail).toEqual({
      code: "CDP_ERROR",
      message: "Connection lost",
      retryable: true,
    });
  });

  it("ignores invalid format and defaults to text", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ format: 123 }, context);

    expect(result.error).toBeUndefined();
    const data = result.result as Record<string, unknown>;
    expect(data.format).toBe("text");
  });

  it("ignores invalid filter and defaults to none", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ filter: true }, context);

    expect(result.error).toBeUndefined();
    expect(engine.takeSnapshotCalls[0]!.options?.filter).toBe("none");
  });

  it("ignores non-boolean diff and defaults to false", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ diff: "yes" }, context);

    expect(result.error).toBeUndefined();
    // Should use serializeSnapshot, not serializeDiff
    expect(engine.serializeSnapshotCalls).toHaveLength(1);
    expect(engine.serializeDiffCalls).toHaveLength(0);
  });

  it("ignores non-number maxTokens", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({ maxTokens: "lots" }, context);

    expect(result.error).toBeUndefined();
    expect(engine.takeSnapshotCalls[0]!.options?.maxTokens).toBeUndefined();
  });

  it("falls back to first tab from status when no active tab", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client, {
      currentTabId: undefined,
      tabs: [
        { tabId: "tab-99", url: "https://fallback.test", title: "Fallback", active: true },
      ],
    });
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({}, context);

    expect(result.error).toBeUndefined();
    expect(engine.takeSnapshotCalls[0]!.tabId).toBe("tab-99");

    const attachCall = client.calls.find((c) => c.method === "Target.attachToTarget");
    expect(attachCall?.params?.targetId).toBe("tab-99");
  });

  it("creates new tab when no tabs exist", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.getTargets", { targetInfos: [] });
    client.queueResponse("Target.createTarget", { targetId: "new-tab" });
    client.queueResponse("Target.attachToTarget", { sessionId: "session-1" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client, {
      currentTabId: undefined,
      tabs: [],
    });
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    const result = await tool.execute({}, context);

    expect(result.error).toBeUndefined();
    expect(engine.takeSnapshotCalls[0]!.tabId).toBe("new-tab");

    const createCall = client.calls.find((c) => c.method === "Target.createTarget");
    expect(createCall?.params?.url).toBe("about:blank");
  });

  it("attaches to target with flatten=true for session-specific CDP", async () => {
    const client = new MockCdpClient();
    client.queueResponse("Target.attachToTarget", { sessionId: "session-42" });

    const engine = new MockSnapshotEngine();
    const service = makeMockService(client);
    const tool = new BrowserSnapshotTool(service, engine as unknown as SnapshotEngine);

    await tool.execute({}, context);

    const attachCall = client.calls.find((c) => c.method === "Target.attachToTarget");
    expect(attachCall?.params).toEqual({ targetId: "tab-1", flatten: true });
    expect(engine.takeSnapshotCalls[0]!.sessionId).toBe("session-42");
  });
});
