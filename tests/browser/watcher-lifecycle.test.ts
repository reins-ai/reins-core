import { describe, expect, it } from "bun:test";

import { BrowserWatcher } from "../../src/browser/watcher";
import { BrowserError } from "../../src/browser/errors";
import type { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import type { CdpMethod, Snapshot, SnapshotDiff, WatcherConfig } from "../../src/browser/types";
import type { SnapshotEngine, TakeSnapshotParams } from "../../src/browser/snapshot";

class MockCdpClient {
  public readonly calls: Array<{ method: CdpMethod; params?: Record<string, unknown>; sessionId?: string }> = [];
  public noPageTargets = false;

  async send<T = unknown>(
    method: CdpMethod,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    this.calls.push({ method, params, sessionId });

    if (method === "Target.getTargets") {
      if (this.noPageTargets) {
        return { targetInfos: [] } as T;
      }
      return {
        targetInfos: [
          { targetId: "tab-1", type: "page", title: "Example", url: "https://example.com", attached: false },
        ],
      } as T;
    }

    if (method === "Target.attachToTarget") {
      return { sessionId: "session-1" } as T;
    }

    if (method === "Target.createTarget") {
      return { targetId: "tab-created" } as T;
    }

    return {} as T;
  }
}

class MockSnapshotEngine {
  public readonly takeSnapshotCalls: TakeSnapshotParams[] = [];
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
    return this.diffToReturn;
  }

  serializeSnapshot(snapshot: Snapshot): string {
    return `snapshot:${snapshot.title}:${snapshot.nodes.length}`;
  }
}

function makeSnapshot(overrides: Partial<Snapshot> = {}): Snapshot {
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
    id: "watcher-lifecycle-001",
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

describe("BrowserWatcher lifecycle", () => {
  describe("pause and resume", () => {
    it("pause sets status to paused", () => {
      const snapshotEngine = new MockSnapshotEngine();
      const watcher = new BrowserWatcher(
        makeConfig(),
        snapshotEngine as unknown as SnapshotEngine,
        makeMockService(new MockCdpClient()),
      );

      watcher.pause();

      const state = watcher.serialize();
      expect(state.status).toBe("paused");
    });

    it("paused watcher cannot take baseline", () => {
      const snapshotEngine = new MockSnapshotEngine();
      snapshotEngine.snapshots.push(makeSnapshot());
      const watcher = new BrowserWatcher(
        makeConfig(),
        snapshotEngine as unknown as SnapshotEngine,
        makeMockService(new MockCdpClient()),
      );

      watcher.pause();

      expect(watcher.takeBaseline()).rejects.toThrow(BrowserError);
    });

    it("paused watcher cannot check for changes", async () => {
      const snapshotEngine = new MockSnapshotEngine();
      snapshotEngine.snapshots.push(makeSnapshot());
      const watcher = new BrowserWatcher(
        makeConfig(),
        snapshotEngine as unknown as SnapshotEngine,
        makeMockService(new MockCdpClient()),
      );

      await watcher.takeBaseline();
      watcher.pause();

      expect(watcher.checkForChanges()).rejects.toThrow(BrowserError);
    });

    it("resume restores active status", () => {
      const snapshotEngine = new MockSnapshotEngine();
      const watcher = new BrowserWatcher(
        makeConfig(),
        snapshotEngine as unknown as SnapshotEngine,
        makeMockService(new MockCdpClient()),
      );

      watcher.pause();
      expect(watcher.serialize().status).toBe("paused");

      watcher.resume();
      expect(watcher.serialize().status).toBe("active");
    });

    it("resume from error clears lastError", () => {
      const snapshotEngine = new MockSnapshotEngine();
      const watcher = new BrowserWatcher(
        makeConfig(),
        snapshotEngine as unknown as SnapshotEngine,
        makeMockService(new MockCdpClient()),
        {
          status: "error",
          lastError: "previous failure",
        },
      );

      expect(watcher.serialize().status).toBe("error");
      expect(watcher.serialize().lastError).toBe("previous failure");

      watcher.resume();

      expect(watcher.serialize().status).toBe("active");
      expect(watcher.serialize().lastError).toBeUndefined();
    });
  });

  describe("createBlankTab fallback", () => {
    it("creates a blank tab when no page targets exist", async () => {
      const client = new MockCdpClient();
      client.noPageTargets = true;

      const snapshotEngine = new MockSnapshotEngine();
      snapshotEngine.snapshots.push(makeSnapshot());

      const service = {
        ensureBrowser: async () => client,
        getCurrentTabId: () => undefined,
      } as unknown as BrowserDaemonService;

      const watcher = new BrowserWatcher(
        makeConfig(),
        snapshotEngine as unknown as SnapshotEngine,
        service,
      );

      await watcher.takeBaseline();

      // Should have called Target.createTarget
      const createCall = client.calls.find((c) => c.method === "Target.createTarget");
      expect(createCall).toBeDefined();
      expect(createCall?.params?.url).toBe("about:blank");
    });
  });

  describe("error handling in checkForChanges", () => {
    it("marks error status when snapshot capture fails", async () => {
      const snapshotEngine = new MockSnapshotEngine();
      snapshotEngine.snapshots.push(makeSnapshot());

      const watcher = new BrowserWatcher(
        makeConfig(),
        snapshotEngine as unknown as SnapshotEngine,
        makeMockService(new MockCdpClient()),
      );

      await watcher.takeBaseline();

      // No more snapshots queued — next call will throw
      try {
        await watcher.checkForChanges();
      } catch {
        // Expected
      }

      expect(watcher.serialize().status).toBe("error");
      expect(watcher.serialize().lastError).toBeDefined();
    });
  });

  describe("checkForChanges without baseline", () => {
    it("throws when no baseline has been taken", async () => {
      const snapshotEngine = new MockSnapshotEngine();
      const watcher = new BrowserWatcher(
        makeConfig(),
        snapshotEngine as unknown as SnapshotEngine,
        makeMockService(new MockCdpClient()),
      );

      expect(watcher.checkForChanges()).rejects.toThrow("no baseline snapshot");
    });
  });
});
