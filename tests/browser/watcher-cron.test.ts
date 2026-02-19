import { describe, expect, it } from "bun:test";

import { BrowserError } from "../../src/browser/errors";
import {
  WatcherCronManager,
  intervalToCron,
} from "../../src/browser/watcher-cron-manager";
import type { NotificationDelivery } from "../../src/browser/conversation-notification-delivery";
import type { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import type {
  CdpMethod,
  Snapshot,
  SnapshotDiff,
  WatcherConfig,
  WatcherDiff,
} from "../../src/browser/types";
import type { SnapshotEngine, TakeSnapshotParams } from "../../src/browser/snapshot";
import type { CronScheduler } from "../../src/cron/scheduler";
import type { CronJobCreateInput, CronJobDefinition, CronResult } from "../../src/cron/types";
import { ok, err } from "../../src/result";
import { CronError } from "../../src/cron/types";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface SendCall {
  method: CdpMethod;
  params?: Record<string, unknown>;
  sessionId?: string;
}

class MockCdpClient {
  public readonly calls: SendCall[] = [];

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
      return { targetId: "tab-created" } as T;
    }

    return {} as T;
  }
}

class MockSnapshotEngine {
  public readonly takeSnapshotCalls: TakeSnapshotParams[] = [];
  public readonly computeDiffCalls: Array<{ prev: Snapshot; current: Snapshot }> = [];
  public snapshots: Snapshot[] = [];
  public diffToReturn: SnapshotDiff = { added: [], changed: [], removed: [] };
  public shouldThrow = false;

  async takeSnapshot(params: TakeSnapshotParams): Promise<Snapshot> {
    this.takeSnapshotCalls.push(params);
    if (this.shouldThrow) {
      throw new BrowserError("Snapshot failed");
    }
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

interface CronCreateCall {
  input: CronJobCreateInput;
}

interface CronRemoveCall {
  id: string;
}

class MockCronScheduler {
  public readonly createCalls: CronCreateCall[] = [];
  public readonly removeCalls: CronRemoveCall[] = [];
  public createShouldFail = false;

  async create(input: CronJobCreateInput): Promise<CronResult<CronJobDefinition>> {
    this.createCalls.push({ input });
    if (this.createShouldFail) {
      return err(new CronError("Create failed", "CRON_JOB_CREATE_FAILED"));
    }
    const job: CronJobDefinition = {
      id: input.id ?? "generated-id",
      name: input.name,
      description: input.description ?? "",
      schedule: input.schedule,
      timezone: "UTC",
      status: "active",
      createdBy: "agent",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      maxRuns: null,
      payload: input.payload,
      tags: [],
    };
    return ok(job);
  }

  async remove(id: string): Promise<CronResult<void>> {
    this.removeCalls.push({ id });
    return ok(undefined);
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

interface NotificationCall {
  watcherId: string;
  url: string;
  diff: WatcherDiff;
}

class MockNotificationDelivery implements NotificationDelivery {
  public readonly calls: NotificationCall[] = [];
  public shouldThrow = false;

  async sendWatcherNotification(
    watcherId: string,
    url: string,
    diff: WatcherDiff,
  ): Promise<void> {
    if (this.shouldThrow) {
      throw new Error("Notification delivery failed");
    }
    this.calls.push({ watcherId, url, diff });
  }
}

function makeManager(overrides?: {
  snapshotEngine?: MockSnapshotEngine;
  cronScheduler?: MockCronScheduler;
  notificationDelivery?: NotificationDelivery;
  maxWatchers?: number;
}): {
  manager: WatcherCronManager;
  snapshotEngine: MockSnapshotEngine;
  cronScheduler: MockCronScheduler;
  client: MockCdpClient;
} {
  const client = new MockCdpClient();
  const snapshotEngine = overrides?.snapshotEngine ?? new MockSnapshotEngine();
  const cronScheduler = overrides?.cronScheduler ?? new MockCronScheduler();

  const manager = new WatcherCronManager({
    snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
    browserService: makeMockService(client),
    cronScheduler: cronScheduler as unknown as CronScheduler,
    notificationDelivery: overrides?.notificationDelivery,
    maxWatchers: overrides?.maxWatchers,
  });

  return { manager, snapshotEngine, cronScheduler, client };
}

// ---------------------------------------------------------------------------
// Tests: intervalToCron
// ---------------------------------------------------------------------------

describe("intervalToCron", () => {
  it("converts 60s to every minute", () => {
    expect(intervalToCron(60)).toBe("* * * * *");
  });

  it("converts 300s to every 5 minutes", () => {
    expect(intervalToCron(300)).toBe("*/5 * * * *");
  });

  it("converts 3600s to every hour", () => {
    expect(intervalToCron(3600)).toBe("0 * * * *");
  });

  it("converts 7200s to every 2 hours", () => {
    expect(intervalToCron(7200)).toBe("0 */2 * * *");
  });

  it("converts 120s to every 2 minutes", () => {
    expect(intervalToCron(120)).toBe("*/2 * * * *");
  });

  it("converts 900s to every 15 minutes", () => {
    expect(intervalToCron(900)).toBe("*/15 * * * *");
  });

  it("handles non-round seconds by ceiling to minutes", () => {
    // 90s → ceil(90/60) = 2 minutes
    expect(intervalToCron(90)).toBe("*/2 * * * *");
  });

  it("handles sub-60s by returning every minute", () => {
    expect(intervalToCron(30)).toBe("* * * * *");
  });

  it("handles non-round hourly multiples by rounding to minutes", () => {
    // 5400s = 90 minutes → not divisible by 60 evenly → */59
    // Actually: ceil(5400/60) = 90, 90 >= 60, 90 % 60 !== 0, min(90, 59) = 59
    expect(intervalToCron(5400)).toBe("*/59 * * * *");
  });
});

// ---------------------------------------------------------------------------
// Tests: WatcherCronManager
// ---------------------------------------------------------------------------

describe("WatcherCronManager", () => {
  it("createWatcher registers watcher and creates cron job", async () => {
    const { manager, snapshotEngine, cronScheduler } = makeManager();
    snapshotEngine.snapshots.push(makeSnapshot());

    const watcher = await manager.createWatcher(makeConfig());

    expect(watcher.id).toBe("watcher-001");
    expect(cronScheduler.createCalls).toHaveLength(1);

    const cronCall = cronScheduler.createCalls[0]!;
    expect(cronCall.input.id).toBe("watcher-cron-watcher-001");
    expect(cronCall.input.schedule).toBe("*/5 * * * *");
    expect(cronCall.input.payload.action).toBe("watcher-check");
    expect(cronCall.input.payload.parameters).toEqual({ watcherId: "watcher-001" });
  });

  it("createWatcher rolls back registry on cron failure", async () => {
    const cronScheduler = new MockCronScheduler();
    cronScheduler.createShouldFail = true;
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(makeSnapshot());

    const { manager } = makeManager({ snapshotEngine, cronScheduler });

    await expect(manager.createWatcher(makeConfig())).rejects.toThrow(CronError);
    expect(manager.listWatchers()).toHaveLength(0);
  });

  it("removeWatcher removes from registry and cron scheduler", async () => {
    const { manager, snapshotEngine, cronScheduler } = makeManager();
    snapshotEngine.snapshots.push(makeSnapshot());

    const watcher = await manager.createWatcher(makeConfig());
    await manager.removeWatcher(watcher.id);

    expect(manager.getWatcher(watcher.id)).toBeUndefined();
    expect(cronScheduler.removeCalls).toHaveLength(1);
    expect(cronScheduler.removeCalls[0]!.id).toBe("watcher-cron-watcher-001");
  });

  it("getWatcher returns registered watcher", async () => {
    const { manager, snapshotEngine } = makeManager();
    snapshotEngine.snapshots.push(makeSnapshot());

    const watcher = await manager.createWatcher(makeConfig());
    expect(manager.getWatcher(watcher.id)).toBe(watcher);
  });

  it("listWatchers returns all watchers", async () => {
    const { manager, snapshotEngine } = makeManager();
    snapshotEngine.snapshots.push(makeSnapshot(), makeSnapshot());

    await manager.createWatcher(makeConfig());
    await manager.createWatcher(makeConfig());

    expect(manager.listWatchers()).toHaveLength(2);
  });

  it("cron execution calls checkForChanges on the watcher", async () => {
    const { manager, snapshotEngine } = makeManager();
    // One snapshot for baseline, one for checkForChanges
    snapshotEngine.snapshots.push(
      makeSnapshot(),
      makeSnapshot({ timestamp: Date.now() + 1000 }),
    );
    snapshotEngine.diffToReturn = {
      added: [{ ref: "e1", backendNodeId: 12, role: "link", name: "New", depth: 0 }],
      changed: [],
      removed: [],
    };

    const watcher = await manager.createWatcher(makeConfig());

    // Simulate cron execution
    await manager.handleCronExecution("watcher-cron-watcher-001");

    const state = watcher.serialize();
    expect(state.lastDiff).toBeDefined();
    expect(state.lastDiff!.hasChanges).toBe(true);
    expect(state.lastDiff!.added).toHaveLength(1);
    expect(state.lastCheckedAt).toBeDefined();
  });

  it("cron execution error sets watcher status to error without throwing", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    // One snapshot for baseline
    snapshotEngine.snapshots.push(makeSnapshot());

    const { manager } = makeManager({ snapshotEngine });

    await manager.createWatcher(makeConfig());

    // Now make snapshot engine throw on next call (checkForChanges)
    snapshotEngine.shouldThrow = true;

    // Should NOT throw
    await manager.handleCronExecution("watcher-cron-watcher-001");

    const watcher = manager.getWatcher("watcher-001");
    expect(watcher).toBeDefined();
    const state = watcher!.serialize();
    expect(state.status).toBe("error");
    expect(state.lastError).toBe("Snapshot failed");
  });

  it("cron execution ignores unknown job IDs", async () => {
    const { manager } = makeManager();

    // Should not throw for unknown job IDs
    await manager.handleCronExecution("unknown-job-id");
    await manager.handleCronExecution("watcher-cron-nonexistent");
  });

  it("uses correct cron schedule based on intervalSeconds", async () => {
    const { manager, snapshotEngine, cronScheduler } = makeManager();
    snapshotEngine.snapshots.push(makeSnapshot());

    await manager.createWatcher(makeConfig({ intervalSeconds: 3600 }));

    const cronCall = cronScheduler.createCalls[0]!;
    expect(cronCall.input.schedule).toBe("0 * * * *");
  });

  it("calls notificationDelivery when diff has changes", async () => {
    const notificationDelivery = new MockNotificationDelivery();
    const snapshotEngine = new MockSnapshotEngine();
    // One snapshot for baseline, one for checkForChanges
    snapshotEngine.snapshots.push(
      makeSnapshot(),
      makeSnapshot({ timestamp: Date.now() + 1000 }),
    );
    snapshotEngine.diffToReturn = {
      added: [{ ref: "e1", backendNodeId: 12, role: "link", name: "New", depth: 0 }],
      changed: [],
      removed: [],
    };

    const { manager } = makeManager({ snapshotEngine, notificationDelivery });
    await manager.createWatcher(makeConfig());

    await manager.handleCronExecution("watcher-cron-watcher-001");

    expect(notificationDelivery.calls).toHaveLength(1);
    const call = notificationDelivery.calls[0]!;
    expect(call.watcherId).toBe("watcher-001");
    expect(call.url).toBe("https://example.com");
    expect(call.diff.hasChanges).toBe(true);
    expect(call.diff.added).toHaveLength(1);
  });

  it("does NOT call notificationDelivery when diff is empty", async () => {
    const notificationDelivery = new MockNotificationDelivery();
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(
      makeSnapshot(),
      makeSnapshot({ timestamp: Date.now() + 1000 }),
    );
    snapshotEngine.diffToReturn = { added: [], changed: [], removed: [] };

    const { manager } = makeManager({ snapshotEngine, notificationDelivery });
    await manager.createWatcher(makeConfig());

    await manager.handleCronExecution("watcher-cron-watcher-001");

    expect(notificationDelivery.calls).toHaveLength(0);
  });

  it("notification delivery error does NOT crash cron execution", async () => {
    const notificationDelivery = new MockNotificationDelivery();
    notificationDelivery.shouldThrow = true;
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(
      makeSnapshot(),
      makeSnapshot({ timestamp: Date.now() + 1000 }),
    );
    snapshotEngine.diffToReturn = {
      added: [{ ref: "e1", backendNodeId: 12, role: "link", name: "New", depth: 0 }],
      changed: [],
      removed: [],
    };

    const { manager } = makeManager({ snapshotEngine, notificationDelivery });
    await manager.createWatcher(makeConfig());

    // Should NOT throw even though notification delivery throws
    await manager.handleCronExecution("watcher-cron-watcher-001");

    // Watcher state should still be updated (checkForChanges succeeded)
    const watcher = manager.getWatcher("watcher-001");
    expect(watcher).toBeDefined();
    const state = watcher!.serialize();
    expect(state.lastDiff).toBeDefined();
    expect(state.lastDiff!.hasChanges).toBe(true);
  });

  it("works without notificationDelivery (backward compatible)", async () => {
    const snapshotEngine = new MockSnapshotEngine();
    snapshotEngine.snapshots.push(
      makeSnapshot(),
      makeSnapshot({ timestamp: Date.now() + 1000 }),
    );
    snapshotEngine.diffToReturn = {
      added: [{ ref: "e1", backendNodeId: 12, role: "link", name: "New", depth: 0 }],
      changed: [],
      removed: [],
    };

    // No notificationDelivery provided
    const { manager } = makeManager({ snapshotEngine });
    await manager.createWatcher(makeConfig());

    // Should NOT throw
    await manager.handleCronExecution("watcher-cron-watcher-001");

    const watcher = manager.getWatcher("watcher-001");
    expect(watcher).toBeDefined();
    expect(watcher!.serialize().lastDiff!.hasChanges).toBe(true);
  });
});
