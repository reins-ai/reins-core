import { describe, expect, it } from "bun:test";

import { BrowserError } from "../../src/browser/errors";
import { BrowserWatcher } from "../../src/browser/watcher";
import { WatcherRegistry } from "../../src/browser/watcher-registry";
import type { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import type { CdpMethod, Snapshot, SnapshotDiff, WatcherConfig, WatcherState } from "../../src/browser/types";
import type { SnapshotEngine, TakeSnapshotParams } from "../../src/browser/snapshot";

interface SendCall {
  method: CdpMethod;
  params?: Record<string, unknown>;
  sessionId?: string;
}

class MockCdpClient {
  public readonly calls: SendCall[] = [];
  public createdTargetId = "tab-created";

  async send<T = unknown>(
    method: CdpMethod,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    this.calls.push({ method, params, sessionId });

    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          {
            targetId: "tab-1",
            type: "page",
            title: "Example",
            url: "https://example.com",
            attached: false,
          },
        ],
      } as T;
    }

    if (method === "Target.attachToTarget") {
      return { sessionId: "session-1" } as T;
    }

    if (method === "Target.createTarget") {
      return { targetId: this.createdTargetId } as T;
    }

    return {} as T;
  }
}

class MockSnapshotEngine {
  public readonly takeSnapshotCalls: TakeSnapshotParams[] = [];
  public readonly computeDiffCalls: Array<{ prev: Snapshot; current: Snapshot }> = [];
  public snapshots: Snapshot[] = [];
  public diffToReturn: SnapshotDiff = { added: [], changed: [], removed: [] };

  async takeSnapshot(params: TakeSnapshotParams): Promise<Snapshot> {
    this.takeSnapshotCalls.push(params);
    const next = this.snapshots.shift();
    if (next === undefined) {
      throw new Error("No snapshot queued");
    }
    return next;
  }

  computeDiff(prev: Snapshot, current: Snapshot): SnapshotDiff {
    this.computeDiffCalls.push({ prev, current });
    return this.diffToReturn;
  }

  serializeSnapshot(snapshot: Snapshot): string {
    return `snapshot:${snapshot.title}:${snapshot.nodes.length}`;
  }
}

function makeSnapshot(
  overrides: Partial<Snapshot> = {},
): Snapshot {
  return {
    tabId: "tab-1",
    url: "https://example.com",
    title: "Example",
    timestamp: Date.now(),
    nodes: [
      { ref: "e0", backendNodeId: 11, role: "button", name: "Save", depth: 0 },
    ],
    format: "compact",
    tokenCount: 20,
    truncated: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return {
    id: "",
    url: "https://example.com",
    intervalSeconds: 300,
    format: "compact",
    filter: "interactive",
    maxTokens: 2000,
    createdAt: Date.now(),
    ...overrides,
  };
}

function makeMockService(client: MockCdpClient): BrowserDaemonService {
  return {
    ensureBrowser: async () => client,
    getCurrentTabId: () => "tab-1",
  } as unknown as BrowserDaemonService;
}

describe("WatcherRegistry", () => {
  it("register creates watcher with baseline snapshot", async () => {
    const client = new MockCdpClient();
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(makeSnapshot());
    const service = makeMockService(client);

    const registry = new WatcherRegistry({
      snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
      browserService: service,
    });

    const watcher = await registry.register(makeConfig());
    const state = watcher.serialize();

    expect(state.config.id).toBe("watcher-001");
    expect(state.baselineSnapshot).toContain("snapshot:Example:1");
    expect(snapshotEngine.takeSnapshotCalls).toHaveLength(1);
    expect(client.calls.some((call) => call.method === "Page.navigate")).toBe(true);
  });

  it("get returns registered watcher", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(makeSnapshot());
    const registry = new WatcherRegistry({
      snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
      browserService: makeMockService(new MockCdpClient()),
    });

    const watcher = await registry.register(makeConfig());
    expect(registry.get(watcher.id)).toBe(watcher);
  });

  it("list returns all watchers", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(makeSnapshot(), makeSnapshot());
    const registry = new WatcherRegistry({
      snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
      browserService: makeMockService(new MockCdpClient()),
    });

    await registry.register(makeConfig());
    await registry.register(makeConfig());

    expect(registry.list()).toHaveLength(2);
  });

  it("remove deletes watcher", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(makeSnapshot());
    const registry = new WatcherRegistry({
      snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
      browserService: makeMockService(new MockCdpClient()),
    });

    const watcher = await registry.register(makeConfig());
    expect(registry.remove(watcher.id)).toBe(true);
    expect(registry.get(watcher.id)).toBeUndefined();
    expect(registry.remove(watcher.id)).toBe(false);
  });

  it("maxWatchers limit enforced", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(makeSnapshot(), makeSnapshot());
    const registry = new WatcherRegistry({
      snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
      browserService: makeMockService(new MockCdpClient()),
      maxWatchers: 1,
    });

    await registry.register(makeConfig());

    await expect(registry.register(makeConfig())).rejects.toThrow(BrowserError);
  });

  it("ID generation is unique and sequential", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(makeSnapshot(), makeSnapshot(), makeSnapshot());
    const registry = new WatcherRegistry({
      snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
      browserService: makeMockService(new MockCdpClient()),
    });

    const first = await registry.register(makeConfig());
    const second = await registry.register(makeConfig());
    const third = await registry.register(makeConfig());

    expect(first.id).toBe("watcher-001");
    expect(second.id).toBe("watcher-002");
    expect(third.id).toBe("watcher-003");
  });

  it("throws on intervalSeconds below minimum", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    const registry = new WatcherRegistry({
      snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
      browserService: makeMockService(new MockCdpClient()),
    });

    await expect(registry.register(makeConfig({ intervalSeconds: 59 }))).rejects.toThrow(BrowserError);
  });
});

describe("BrowserWatcher", () => {
  it("checkForChanges returns hasChanges=true when diff contains changes", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(makeSnapshot(), makeSnapshot({ timestamp: Date.now() + 1000 }));
    snapshotEngine.diffToReturn = {
      added: [{ ref: "e1", backendNodeId: 12, role: "link", name: "New", depth: 0 }],
      changed: [],
      removed: [],
    };

    const watcher = new BrowserWatcher(
      makeConfig({ id: "watcher-050" }),
      snapshotEngine as unknown as SnapshotEngine,
      makeMockService(new MockCdpClient()),
    );

    await watcher.takeBaseline();
    const diff = await watcher.checkForChanges();

    expect(diff.hasChanges).toBe(true);
    expect(diff.added).toHaveLength(1);
  });

  it("checkForChanges returns hasChanges=false for empty diff", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(makeSnapshot(), makeSnapshot({ timestamp: Date.now() + 1000 }));
    snapshotEngine.diffToReturn = { added: [], changed: [], removed: [] };

    const watcher = new BrowserWatcher(
      makeConfig({ id: "watcher-051" }),
      snapshotEngine as unknown as SnapshotEngine,
      makeMockService(new MockCdpClient()),
    );

    await watcher.takeBaseline();
    const diff = await watcher.checkForChanges();

    expect(diff.hasChanges).toBe(false);
  });

  it("serialize and deserialize round-trip preserves state", () => {
    const state: WatcherState = {
      config: makeConfig({ id: "watcher-099" }),
      status: "error",
      baselineSnapshot: "snapshot:Example:1",
      lastDiff: {
        added: ["e2:button \"New\""],
        changed: [],
        removed: [],
        timestamp: Date.now(),
        hasChanges: true,
      },
      lastCheckedAt: Date.now(),
      lastError: "network timeout",
    };

    const watcher = BrowserWatcher.deserialize(
      state,
      new MockSnapshotEngine() as unknown as SnapshotEngine,
      makeMockService(new MockCdpClient()),
    );

    expect(watcher.serialize()).toEqual(state);
  });
});
