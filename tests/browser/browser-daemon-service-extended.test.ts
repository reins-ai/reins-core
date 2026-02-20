import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import type { WatcherManagerLike } from "../../src/browser/browser-daemon-service";
import { CdpClient } from "../../src/browser/cdp-client";

interface MockProcess {
  pid?: number;
  kill(signal?: number): void;
  exited: Promise<number>;
}

class MockCdpClient {
  public isConnected = false;
  public connectCalls = 0;
  public disconnectCalls = 0;
  public sendResults = new Map<string, unknown>();

  async connect(): Promise<void> {
    this.connectCalls += 1;
    this.isConnected = true;
  }

  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
    this.isConnected = false;
  }

  async send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const result = this.sendResults.get(method);
    if (result instanceof Error) {
      throw result;
    }
    return (result ?? {}) as T;
  }
}

function createMockProcess(pid = 4567): {
  process: MockProcess;
  killSignals: number[];
} {
  const killSignals: number[] = [];
  let resolveExit: ((value: number) => void) | undefined;
  const exited = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });

  const process: MockProcess = {
    pid,
    kill(signal?: number): void {
      killSignals.push(signal ?? 15);
      if (resolveExit) {
        resolveExit(0);
        resolveExit = undefined;
      }
    },
    exited,
  };

  return { process, killSignals };
}

function createService(overrides: {
  mockClient?: MockCdpClient;
  mockProcess?: MockProcess;
  watcherManager?: WatcherManagerLike;
  config?: Record<string, unknown>;
} = {}): {
  service: BrowserDaemonService;
  mockClient: MockCdpClient;
  mockProcess: MockProcess;
} {
  const mockClient = overrides.mockClient ?? new MockCdpClient();
  const { process: mockProcess } = overrides.mockProcess
    ? { process: overrides.mockProcess }
    : createMockProcess(7777);

  const service = new BrowserDaemonService({
    config: {
      port: 9999,
      profilePath: "/tmp/reins-test-extended",
      ...overrides.config,
    },
    findBinaryFn: async () => "/usr/bin/chromium",
    cdpClientFactory: () => mockClient as unknown as CdpClient,
    spawnFn: (() => mockProcess as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn,
    watcherManager: overrides.watcherManager,
  });

  return { service, mockClient, mockProcess };
}

describe("BrowserDaemonService extended coverage", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    BrowserDaemonService._resetBunSpawnForTests();
    globalThis.fetch = async () => ({ ok: true } as Response);
  });

  afterEach(() => {
    BrowserDaemonService._resetBunSpawnForTests();
    globalThis.fetch = originalFetch;
  });

  describe("setWatcherManager", () => {
    it("wires watcher manager after construction", () => {
      const { service } = createService();
      const manager: WatcherManagerLike = {
        resumeWatchers: async () => {},
        stopAllCronJobs: async () => {},
      };

      // Should not throw
      service.setWatcherManager(manager);
    });
  });

  describe("start() with watcher manager", () => {
    it("calls resumeWatchers on start", async () => {
      let resumed = false;
      const manager: WatcherManagerLike = {
        resumeWatchers: async () => { resumed = true; },
        stopAllCronJobs: async () => {},
      };

      const { service } = createService({ watcherManager: manager });
      const result = await service.start();

      expect(result.ok).toBe(true);
      expect(resumed).toBe(true);
    });

    it("does not fail if resumeWatchers throws", async () => {
      const manager: WatcherManagerLike = {
        resumeWatchers: async () => { throw new Error("resume failed"); },
        stopAllCronJobs: async () => {},
      };

      const { service } = createService({ watcherManager: manager });
      const result = await service.start();

      expect(result.ok).toBe(true);
    });
  });

  describe("stop() with watcher manager", () => {
    it("calls stopAllCronJobs on stop", async () => {
      let stopped = false;
      const manager: WatcherManagerLike = {
        resumeWatchers: async () => {},
        stopAllCronJobs: async () => { stopped = true; },
      };

      const { service } = createService({ watcherManager: manager });
      const result = await service.stop();

      expect(result.ok).toBe(true);
      expect(stopped).toBe(true);
    });

    it("does not fail if stopAllCronJobs throws", async () => {
      const manager: WatcherManagerLike = {
        resumeWatchers: async () => {},
        stopAllCronJobs: async () => { throw new Error("stop failed"); },
      };

      const { service } = createService({ watcherManager: manager });
      const result = await service.stop();

      expect(result.ok).toBe(true);
    });
  });

  describe("updateTabState", () => {
    it("stores tabs and normalizes active tab", async () => {
      const { service } = createService();
      await service.ensureBrowser();

      service.updateTabState(
        [
          { tabId: "t1", url: "https://a.com", title: "A", active: false },
          { tabId: "t2", url: "https://b.com", title: "B", active: false },
        ],
        "t2",
      );

      const status = service.getStatus();
      expect(status.tabs).toHaveLength(2);
      expect(status.activeTabId).toBe("t2");
      expect(status.tabs.find((t) => t.tabId === "t2")?.active).toBe(true);
      expect(status.tabs.find((t) => t.tabId === "t1")?.active).toBe(false);
    });

    it("falls back to first tab when activeTabId is not in list", async () => {
      const { service } = createService();
      await service.ensureBrowser();

      service.updateTabState(
        [
          { tabId: "t1", url: "https://a.com", title: "A", active: false },
          { tabId: "t2", url: "https://b.com", title: "B", active: false },
        ],
        "nonexistent",
      );

      const status = service.getStatus();
      expect(status.activeTabId).toBe("t1");
    });

    it("falls back to first tab when activeTabId is undefined", async () => {
      const { service } = createService();
      await service.ensureBrowser();

      service.updateTabState([
        { tabId: "t1", url: "https://a.com", title: "A", active: false },
      ]);

      const status = service.getStatus();
      expect(status.activeTabId).toBe("t1");
    });
  });

  describe("getCurrentTabId", () => {
    it("returns undefined before any tab state is set", () => {
      const { service } = createService();
      expect(service.getCurrentTabId()).toBeUndefined();
    });

    it("returns active tab ID after updateTabState", async () => {
      const { service } = createService();
      await service.ensureBrowser();

      service.updateTabState(
        [{ tabId: "t1", url: "https://a.com", title: "A", active: true }],
        "t1",
      );

      expect(service.getCurrentTabId()).toBe("t1");
    });
  });

  describe("getActiveCdpClient", () => {
    it("returns existing client when browser is healthy", async () => {
      const { service, mockClient } = createService();
      await service.ensureBrowser();

      const client = await service.getActiveCdpClient();
      expect(client).toBe(mockClient as unknown as CdpClient);
      // Should not have spawned a second time
      expect(mockClient.connectCalls).toBe(1);
    });

    it("launches browser when not running", async () => {
      const { service, mockClient } = createService();

      const client = await service.getActiveCdpClient();
      expect(client).toBe(mockClient as unknown as CdpClient);
      expect(mockClient.connectCalls).toBe(1);
    });
  });

  describe("takeScreenshot", () => {
    it("returns error when browser is not running", async () => {
      const { service } = createService();

      const result = await service.takeScreenshot();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BROWSER_NOT_RUNNING");
      }
    });

    it("captures screenshot and returns file path on success", async () => {
      const mockClient = new MockCdpClient();
      // Base64 of a tiny JPEG-like payload
      mockClient.sendResults.set("Page.captureScreenshot", {
        data: Buffer.from("fake-jpeg-data").toString("base64"),
      });

      const { service } = createService({
        mockClient,
        config: { screenshotDir: "/tmp/reins-test-screenshots" },
      });
      await service.ensureBrowser();

      const result = await service.takeScreenshot(80);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.path).toContain("screenshot-");
        expect(result.value.path).toEndWith(".jpg");
      }
    });

    it("returns error when CDP send fails", async () => {
      const mockClient = new MockCdpClient();
      mockClient.sendResults.set("Page.captureScreenshot", new Error("CDP timeout"));

      const { service } = createService({ mockClient });
      await service.ensureBrowser();

      const result = await service.takeScreenshot();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("SCREENSHOT_FAILED");
        expect(result.error.message).toContain("CDP timeout");
      }
    });
  });

  describe("launchHeaded error path", () => {
    it("returns error result when Chrome launch fails", async () => {
      const service = new BrowserDaemonService({
        config: { port: 9111, profilePath: "/tmp/reins-headed-fail" },
        findBinaryFn: async () => { throw new Error("binary not found"); },
        cdpClientFactory: () => new MockCdpClient() as unknown as CdpClient,
        spawnFn: (() => createMockProcess().process as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn,
      });

      const result = await service.launchHeaded();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BROWSER_LAUNCH_HEADED_FAILED");
      }
    });
  });

  describe("launchHeadless error path", () => {
    it("returns error result when Chrome launch fails", async () => {
      const service = new BrowserDaemonService({
        config: { port: 9112, profilePath: "/tmp/reins-headless-fail" },
        findBinaryFn: async () => { throw new Error("binary not found"); },
        cdpClientFactory: () => new MockCdpClient() as unknown as CdpClient,
        spawnFn: (() => createMockProcess().process as unknown as ReturnType<typeof Bun.spawn>) as typeof Bun.spawn,
      });

      const result = await service.launchHeadless();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BROWSER_LAUNCH_HEADLESS_FAILED");
      }
    });
  });

  describe("stop() error path", () => {
    it("returns error result when stopChrome throws unexpectedly", async () => {
      const mockClient = new MockCdpClient();
      // Make disconnect throw
      mockClient.disconnect = async () => { throw new Error("disconnect boom"); };

      const { service } = createService({ mockClient });
      await service.ensureBrowser();

      const result = await service.stop();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("BROWSER_DAEMON_STOP_FAILED");
      }
    });
  });

  describe("getStatus running state", () => {
    it("includes memoryUsageMb, webSocketDebuggerUrl, and startedAt", async () => {
      const { service } = createService();
      await service.ensureBrowser();

      const status = service.getStatus();

      expect(status.running).toBe(true);
      expect(status.chrome?.webSocketDebuggerUrl).toContain("ws://127.0.0.1:");
      expect(typeof status.chrome?.startedAt).toBe("number");
      expect(status.headless).toBe(false);
    });
  });

  describe("headless mode flag", () => {
    it("includes headless=true in status when configured", async () => {
      const { service } = createService({ config: { headless: true } });
      const status = service.getStatus();
      expect(status.headless).toBe(true);
    });
  });
});
