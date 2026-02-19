import { describe, expect, it } from "bun:test";

import { BrowserError } from "../../src/browser/errors";
import { BrowserWatcher } from "../../src/browser/watcher";
import { WatcherRegistry } from "../../src/browser/watcher-registry";
import { WatcherCronManager } from "../../src/browser/watcher-cron-manager";
import type { WatcherPersistenceIO } from "../../src/browser/watcher-cron-manager";
import {
  ConversationNotificationDelivery,
  formatWatcherNotification,
} from "../../src/browser/conversation-notification-delivery";
import type { NotificationDelivery, NotificationLogger } from "../../src/browser/conversation-notification-delivery";
import type { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import type { CdpMethod, Snapshot, SnapshotDiff, WatcherConfig, WatcherDiff, WatcherState } from "../../src/browser/types";
import type { SnapshotEngine, TakeSnapshotParams } from "../../src/browser/snapshot";
import type { ConversationManager } from "../../src/conversation/manager";
import type { CronScheduler } from "../../src/cron/scheduler";
import type { CronJobCreateInput, CronJobDefinition, CronResult } from "../../src/cron/types";
import { ok, err } from "../../src/result";
import { CronError } from "../../src/cron/types";

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

// ---------------------------------------------------------------------------
// Notification formatting and delivery tests
// ---------------------------------------------------------------------------

function makeDiff(overrides: Partial<WatcherDiff> = {}): WatcherDiff {
  return {
    added: [],
    changed: [],
    removed: [],
    timestamp: Date.now(),
    hasChanges: false,
    ...overrides,
  };
}

class MockNotificationLogger implements NotificationLogger {
  public readonly warnings: string[] = [];
  public readonly errors: string[] = [];

  warn(message: string): void {
    this.warnings.push(message);
  }

  error(message: string): void {
    this.errors.push(message);
  }
}

interface AddMessageCall {
  conversationId: string;
  message: { role: string; content: string };
}

class MockConversationManager {
  public readonly addMessageCalls: AddMessageCall[] = [];
  public conversations: Array<{ id: string; title: string }> = [];
  public listShouldThrow = false;
  public addMessageShouldThrow = false;

  async list() {
    if (this.listShouldThrow) {
      throw new Error("list failed");
    }
    return this.conversations;
  }

  async addMessage(
    conversationId: string,
    message: { role: string; content: string },
  ) {
    if (this.addMessageShouldThrow) {
      throw new Error("addMessage failed");
    }
    this.addMessageCalls.push({ conversationId, message });
    return { id: "msg-1", ...message, createdAt: new Date() };
  }
}

describe("formatWatcherNotification", () => {
  it("includes watcher ID, URL, and change counts", () => {
    const diff = makeDiff({
      added: ["e1:button \"New\"", "e2:link \"Home\""],
      changed: ["e3:input \"Search\""],
      removed: [],
      hasChanges: true,
    });

    const message = formatWatcherNotification("watcher-001", "https://example.com", diff);

    expect(message).toContain("watcher-001");
    expect(message).toContain("https://example.com");
    expect(message).toContain("Added: 2 elements");
    expect(message).toContain("Changed: 1 elements");
    expect(message).toContain("Removed: 0 elements");
  });

  it("includes diff content for added, changed, and removed elements", () => {
    const diff = makeDiff({
      added: ["e1:button \"Save\""],
      changed: ["e2:input \"Name\""],
      removed: ["e3:link \"Old\""],
      hasChanges: true,
    });

    const message = formatWatcherNotification("watcher-002", "https://example.com", diff);

    expect(message).toContain("e1:button \"Save\"");
    expect(message).toContain("e2:input \"Name\"");
    expect(message).toContain("e3:link \"Old\"");
  });

  it("truncates diff content at 500 chars", () => {
    const longElements = Array.from({ length: 50 }, (_, i) =>
      `e${i}:button "A very long element name that takes up space number ${i}"`,
    );

    const diff = makeDiff({
      added: longElements,
      changed: [],
      removed: [],
      hasChanges: true,
    });

    const message = formatWatcherNotification("watcher-003", "https://example.com", diff);

    expect(message).toContain("[...truncated]");
    // The diff content portion should be truncated, but the header should be intact
    expect(message).toContain("watcher-003");
    expect(message).toContain(`Added: ${longElements.length} elements`);
  });

  it("produces no diff content section for empty diff", () => {
    const diff = makeDiff({ hasChanges: false });

    const message = formatWatcherNotification("watcher-004", "https://example.com", diff);

    expect(message).toContain("Added: 0 elements");
    expect(message).toContain("Changed: 0 elements");
    expect(message).toContain("Removed: 0 elements");
    // No diff content lines beyond the summary
    expect(message).not.toContain("[...truncated]");
  });
});

describe("ConversationNotificationDelivery", () => {
  it("delivers notification to the most recently active conversation", async () => {
    const mockManager = new MockConversationManager();
    mockManager.conversations = [{ id: "conv-1", title: "Active Chat" }];
    const logger = new MockNotificationLogger();

    const delivery = new ConversationNotificationDelivery(
      mockManager as unknown as ConversationManager,
      logger,
    );

    const diff = makeDiff({
      added: ["e1:button \"New\""],
      changed: [],
      removed: [],
      hasChanges: true,
    });

    await delivery.sendWatcherNotification("watcher-001", "https://example.com", diff);

    expect(mockManager.addMessageCalls).toHaveLength(1);
    const call = mockManager.addMessageCalls[0]!;
    expect(call.conversationId).toBe("conv-1");
    expect(call.message.role).toBe("system");
    expect(call.message.content).toContain("watcher-001");
    expect(call.message.content).toContain("https://example.com");
  });

  it("logs warning and returns when no conversation is active", async () => {
    const mockManager = new MockConversationManager();
    mockManager.conversations = [];
    const logger = new MockNotificationLogger();

    const delivery = new ConversationNotificationDelivery(
      mockManager as unknown as ConversationManager,
      logger,
    );

    const diff = makeDiff({ added: ["e1:link \"X\""], hasChanges: true });

    await delivery.sendWatcherNotification("watcher-002", "https://example.com", diff);

    expect(mockManager.addMessageCalls).toHaveLength(0);
    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain("no active conversation");
  });

  it("does not crash when list throws", async () => {
    const mockManager = new MockConversationManager();
    mockManager.listShouldThrow = true;
    const logger = new MockNotificationLogger();

    const delivery = new ConversationNotificationDelivery(
      mockManager as unknown as ConversationManager,
      logger,
    );

    const diff = makeDiff({ added: ["e1:link \"X\""], hasChanges: true });

    // Should not throw
    await delivery.sendWatcherNotification("watcher-003", "https://example.com", diff);

    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toContain("notification delivery failed");
  });

  it("does not crash when addMessage throws", async () => {
    const mockManager = new MockConversationManager();
    mockManager.conversations = [{ id: "conv-1", title: "Chat" }];
    mockManager.addMessageShouldThrow = true;
    const logger = new MockNotificationLogger();

    const delivery = new ConversationNotificationDelivery(
      mockManager as unknown as ConversationManager,
      logger,
    );

    const diff = makeDiff({ added: ["e1:link \"X\""], hasChanges: true });

    // Should not throw
    await delivery.sendWatcherNotification("watcher-004", "https://example.com", diff);

    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]).toContain("notification delivery failed");
  });

  it("notification message contains change counts", async () => {
    const mockManager = new MockConversationManager();
    mockManager.conversations = [{ id: "conv-1", title: "Chat" }];
    const logger = new MockNotificationLogger();

    const delivery = new ConversationNotificationDelivery(
      mockManager as unknown as ConversationManager,
      logger,
    );

    const diff = makeDiff({
      added: ["e1:button \"A\"", "e2:button \"B\""],
      changed: ["e3:input \"C\""],
      removed: ["e4:link \"D\"", "e5:link \"E\"", "e6:link \"F\""],
      hasChanges: true,
    });

    await delivery.sendWatcherNotification("watcher-005", "https://example.com", diff);

    const content = mockManager.addMessageCalls[0]!.message.content;
    expect(content).toContain("Added: 2 elements");
    expect(content).toContain("Changed: 1 elements");
    expect(content).toContain("Removed: 3 elements");
  });
});

// ---------------------------------------------------------------------------
// Persistence tests (WatcherCronManager)
// ---------------------------------------------------------------------------

class MockCronSchedulerForPersist {
  public readonly createCalls: Array<{ input: CronJobCreateInput }> = [];
  public readonly removeCalls: Array<{ id: string }> = [];
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

interface FsWriteCall {
  path: string;
  data: string;
  encoding?: string;
}

interface FsRenameCall {
  oldPath: string;
  newPath: string;
}

interface FsMkdirCall {
  path: string;
  options?: { recursive?: boolean };
}

class MockPersistenceIO implements WatcherPersistenceIO {
  public fileContents = new Map<string, string>();
  public readonly writeCalls: FsWriteCall[] = [];
  public readonly renameCalls: FsRenameCall[] = [];
  public readonly mkdirCalls: FsMkdirCall[] = [];
  public readShouldThrow?: Error;

  async readFile(path: string | Buffer | URL, _encoding?: string): Promise<string> {
    const pathStr = String(path);
    if (this.readShouldThrow) {
      throw this.readShouldThrow;
    }
    const content = this.fileContents.get(pathStr);
    if (content === undefined) {
      const error = new Error(`ENOENT: no such file or directory, open '${pathStr}'`) as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return content;
  }

  async writeFile(path: string | Buffer | URL, data: string | Buffer | Uint8Array, encoding?: string): Promise<void> {
    const pathStr = String(path);
    this.writeCalls.push({ path: pathStr, data: String(data), encoding: encoding as string | undefined });
    this.fileContents.set(pathStr, String(data));
  }

  async rename(oldPath: string | Buffer | URL, newPath: string | Buffer | URL): Promise<void> {
    const oldStr = String(oldPath);
    const newStr = String(newPath);
    this.renameCalls.push({ oldPath: oldStr, newPath: newStr });
    const content = this.fileContents.get(oldStr);
    if (content !== undefined) {
      this.fileContents.set(newStr, content);
      this.fileContents.delete(oldStr);
    }
  }

  async mkdir(path: string | Buffer | URL, _options?: { recursive?: boolean }): Promise<string | undefined> {
    this.mkdirCalls.push({ path: String(path), options: _options as { recursive?: boolean } | undefined });
    return undefined;
  }
}

function makePersistManager(overrides?: {
  io?: MockPersistenceIO;
  cronScheduler?: MockCronSchedulerForPersist;
  watchersFilePath?: string;
}): {
  manager: WatcherCronManager;
  snapshotEngine: MockSnapshotEngine;
  cronScheduler: MockCronSchedulerForPersist;
  io: MockPersistenceIO;
} {
  const client = new MockCdpClient();
  const snapshotEngine = new MockSnapshotEngine();
  const cronScheduler = overrides?.cronScheduler ?? new MockCronSchedulerForPersist();
  const io = overrides?.io ?? new MockPersistenceIO();

  const manager = new WatcherCronManager({
    snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
    browserService: makeMockService(client),
    cronScheduler: cronScheduler as unknown as CronScheduler,
    watchersFilePath: overrides?.watchersFilePath ?? "/tmp/test-watchers.json",
    persistenceIO: io as unknown as WatcherPersistenceIO,
  });

  return { manager, snapshotEngine, cronScheduler, io };
}

describe("WatcherCronManager persist", () => {
  it("resumeWatchers loads watchers from file", async () => {
    const io = new MockPersistenceIO();
    const states: WatcherState[] = [
      {
        config: makeConfig({ id: "watcher-010", intervalSeconds: 300 }),
        status: "active",
        baselineSnapshot: "snapshot:Example:1",
        lastCheckedAt: Date.now(),
      },
      {
        config: makeConfig({ id: "watcher-011", intervalSeconds: 600 }),
        status: "active",
        baselineSnapshot: "snapshot:Other:2",
      },
    ];
    io.fileContents.set("/tmp/test-watchers.json", JSON.stringify(states));

    const { manager, cronScheduler } = makePersistManager({ io });

    await manager.resumeWatchers();

    const watchers = manager.listWatchers();
    expect(watchers).toHaveLength(2);
    expect(watchers.map((w) => w.id).sort()).toEqual(["watcher-010", "watcher-011"]);

    // Cron jobs should be scheduled for each resumed watcher
    expect(cronScheduler.createCalls).toHaveLength(2);
    expect(cronScheduler.createCalls[0]!.input.id).toBe("watcher-cron-watcher-010");
    expect(cronScheduler.createCalls[1]!.input.id).toBe("watcher-cron-watcher-011");
  });

  it("watcher file is saved after createWatcher", async () => {
    const io = new MockPersistenceIO();
    const { manager, snapshotEngine } = makePersistManager({ io });
    snapshotEngine.snapshots.push(makeSnapshot());

    await manager.createWatcher(makeConfig());

    // Should have written to tmp file and renamed
    expect(io.writeCalls).toHaveLength(1);
    expect(io.writeCalls[0]!.path).toBe("/tmp/test-watchers.json.tmp");
    expect(io.renameCalls).toHaveLength(1);
    expect(io.renameCalls[0]!.oldPath).toBe("/tmp/test-watchers.json.tmp");
    expect(io.renameCalls[0]!.newPath).toBe("/tmp/test-watchers.json");

    // Verify the content is valid JSON with the watcher state
    const savedContent = io.fileContents.get("/tmp/test-watchers.json");
    expect(savedContent).toBeDefined();
    const parsed = JSON.parse(savedContent!) as WatcherState[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.config.id).toBe("watcher-001");
  });

  it("watcher file is saved after removeWatcher", async () => {
    const io = new MockPersistenceIO();
    const { manager, snapshotEngine } = makePersistManager({ io });
    snapshotEngine.snapshots.push(makeSnapshot());

    const watcher = await manager.createWatcher(makeConfig());
    io.writeCalls.length = 0;
    io.renameCalls.length = 0;

    await manager.removeWatcher(watcher.id);

    expect(io.writeCalls).toHaveLength(1);
    const savedContent = io.fileContents.get("/tmp/test-watchers.json");
    const parsed = JSON.parse(savedContent!) as WatcherState[];
    expect(parsed).toHaveLength(0);
  });

  it("corrupt JSON in watchers file is handled gracefully", async () => {
    const io = new MockPersistenceIO();
    io.fileContents.set("/tmp/test-watchers.json", "not valid json {{{");

    const { manager } = makePersistManager({ io });

    // Should not throw
    await manager.resumeWatchers();

    expect(manager.listWatchers()).toHaveLength(0);
  });

  it("non-array JSON in watchers file is handled gracefully", async () => {
    const io = new MockPersistenceIO();
    io.fileContents.set("/tmp/test-watchers.json", JSON.stringify({ not: "an array" }));

    const { manager } = makePersistManager({ io });

    // Should not throw
    await manager.resumeWatchers();

    expect(manager.listWatchers()).toHaveLength(0);
  });

  it("missing watchers file is handled gracefully", async () => {
    const io = new MockPersistenceIO();
    // No file set — readFile will throw ENOENT

    const { manager } = makePersistManager({ io });

    // Should not throw
    await manager.resumeWatchers();

    expect(manager.listWatchers()).toHaveLength(0);
  });

  it("REINS_BROWSER_WATCHERS_FILE env var overrides path", async () => {
    const original = process.env.REINS_BROWSER_WATCHERS_FILE;
    try {
      process.env.REINS_BROWSER_WATCHERS_FILE = "/custom/watchers.json";

      const client = new MockCdpClient();
      const snapshotEngine = new MockSnapshotEngine();
      const cronScheduler = new MockCronSchedulerForPersist();
      const io = new MockPersistenceIO();

      const states: WatcherState[] = [
        {
          config: makeConfig({ id: "watcher-env-test", intervalSeconds: 300 }),
          status: "active",
          baselineSnapshot: "snapshot:Test:1",
        },
      ];
      io.fileContents.set("/custom/watchers.json", JSON.stringify(states));

      // Create manager WITHOUT explicit watchersFilePath — should use env var
      const manager = new WatcherCronManager({
        snapshotEngine: snapshotEngine as unknown as SnapshotEngine,
        browserService: makeMockService(client),
        cronScheduler: cronScheduler as unknown as CronScheduler,
        persistenceIO: io as unknown as WatcherPersistenceIO,
      });

      await manager.resumeWatchers();

      expect(manager.listWatchers()).toHaveLength(1);
      expect(manager.listWatchers()[0]!.id).toBe("watcher-env-test");
    } finally {
      if (original === undefined) {
        delete process.env.REINS_BROWSER_WATCHERS_FILE;
      } else {
        process.env.REINS_BROWSER_WATCHERS_FILE = original;
      }
    }
  });

  it("stopAllCronJobs removes cron jobs for all watchers", async () => {
    const io = new MockPersistenceIO();
    const { manager, snapshotEngine, cronScheduler } = makePersistManager({ io });
    snapshotEngine.snapshots.push(makeSnapshot(), makeSnapshot());

    await manager.createWatcher(makeConfig());
    await manager.createWatcher(makeConfig());
    cronScheduler.removeCalls.length = 0;

    await manager.stopAllCronJobs();

    expect(cronScheduler.removeCalls).toHaveLength(2);
    const removedIds = cronScheduler.removeCalls.map((c) => c.id).sort();
    expect(removedIds).toEqual(["watcher-cron-watcher-001", "watcher-cron-watcher-002"]);
  });

  it("persistence uses atomic write (tmp + rename)", async () => {
    const io = new MockPersistenceIO();
    const { manager, snapshotEngine } = makePersistManager({ io });
    snapshotEngine.snapshots.push(makeSnapshot());

    await manager.createWatcher(makeConfig());

    // Verify atomic write pattern
    expect(io.mkdirCalls).toHaveLength(1);
    expect(io.mkdirCalls[0]!.options).toEqual({ recursive: true });
    expect(io.writeCalls[0]!.path).toEndWith(".tmp");
    expect(io.renameCalls[0]!.oldPath).toEndWith(".tmp");
    expect(io.renameCalls[0]!.newPath).toBe("/tmp/test-watchers.json");
  });
});
