import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createLogger } from "../logger";
import { err, ok, type Result } from "../result";

const log = createLogger("browser:daemon-service");
import { DaemonError, type DaemonManagedService } from "../daemon/types";
import { CdpClient } from "./cdp-client";
import { findChromeBinary } from "./chrome-finder";
import { BrowserError } from "./errors";
import { injectStealthScripts } from "./stealth";
import type { BrowserConfig, BrowserStatus, CaptureScreenshotResult, TabInfo } from "./types";

const DEFAULT_CONFIG: BrowserConfig = {
  profilePath: process.env.REINS_BROWSER_PROFILE?.trim() || `${homedir()}/.reins/browser/profiles/default`,
  port: 9222,
  headless: false,
  maxWatchers: 10,
};

const CHROME_FLAGS = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-default-apps",
  "--disable-extensions",
  "--disable-popup-blocking",
  "--disable-background-networking",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-breakpad",
  "--disable-client-side-phishing-detection",
  "--disable-component-extensions-with-background-pages",
  "--disable-ipc-flooding-protection",
  "--disable-hang-monitor",
  "--disable-sync",
  "--metrics-recording-only",
  "--no-first-run",
  "--safebrowsing-disable-auto-update",
];

type SpawnFn = typeof Bun.spawn;

export interface BrowserDaemonServiceOptions {
  config?: Partial<BrowserConfig>;
  spawnFn?: SpawnFn;
  findBinaryFn?: () => Promise<string>;
  cdpClientFactory?: (port: number) => CdpClient;
  watcherManager?: WatcherManagerLike;
}

/**
 * Minimal interface for the watcher manager lifecycle hooks.
 * Avoids circular dependency with WatcherCronManager.
 */
export interface WatcherManagerLike {
  resumeWatchers(): Promise<void>;
  stopAllCronJobs(): Promise<void>;
}

export class BrowserDaemonService implements DaemonManagedService {
  readonly id = "browser";

  private static bunSpawnFn: SpawnFn = Bun.spawn;

  private readonly config: BrowserConfig;
  private readonly spawnFn: SpawnFn;
  private readonly findBinaryFn: () => Promise<string>;
  private readonly cdpClientFactory: (port: number) => CdpClient;
  private watcherManager?: WatcherManagerLike;

  private chromeProcess: ReturnType<SpawnFn> | null = null;
  private cdpClient: CdpClient | null = null;
  private launchPromise: Promise<CdpClient> | null = null;
  private startedAt?: number;
  private processExited = false;
  private tabs: TabInfo[] = [];
  private activeTabId?: string;

  constructor(options: BrowserDaemonServiceOptions = {}) {
    this.config = {
      ...DEFAULT_CONFIG,
      ...options.config,
    };
    this.spawnFn = options.spawnFn ?? BrowserDaemonService.bunSpawnFn;
    this.findBinaryFn = options.findBinaryFn ?? findChromeBinary;
    this.cdpClientFactory = options.cdpClientFactory ?? ((port) => new CdpClient({ port }));
    this.watcherManager = options.watcherManager;
  }

  /**
   * Wire in the watcher manager after construction. Used to break the
   * circular dependency between BrowserDaemonService and WatcherCronManager
   * (each needs the other at construction time).
   */
  setWatcherManager(manager: WatcherManagerLike): void {
    this.watcherManager = manager;
  }

  static _setBunSpawnForTests(fn: typeof Bun.spawn): void {
    BrowserDaemonService.bunSpawnFn = fn;
  }

  static _resetBunSpawnForTests(): void {
    BrowserDaemonService.bunSpawnFn = Bun.spawn;
  }

  async start(): Promise<Result<void, DaemonError>> {
    if (this.watcherManager) {
      try {
        await this.watcherManager.resumeWatchers();
      } catch (e) {
        // Expected: watcher resume errors must not prevent daemon startup
        log.warn("failed to resume watchers during startup", { error: e instanceof Error ? e.message : String(e) });
      }
    }
    return ok(undefined);
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<Result<void, DaemonError>> {
    try {
      if (this.watcherManager) {
        try {
          await this.watcherManager.stopAllCronJobs();
        } catch (e) {
          // Expected: watcher cleanup errors must not prevent daemon shutdown
          log.warn("failed to stop watcher cron jobs during shutdown", { error: e instanceof Error ? e.message : String(e) });
        }
      }
      await this.stopChrome(signal);
      return ok(undefined);
    } catch (error) {
      return err(new DaemonError(
        `Failed to stop browser daemon service: ${error instanceof Error ? error.message : String(error)}`,
        "BROWSER_DAEMON_STOP_FAILED",
        error instanceof Error ? error : undefined,
      ));
    }
  }

  /**
   * Stop the current Chrome process (if running) and relaunch in headed
   * (visible window) mode. Watcher cron jobs are intentionally NOT stopped —
   * this is a Chrome restart, not a full service shutdown.
   */
  async launchHeaded(): Promise<Result<void, DaemonError>> {
    try {
      await this.stopChrome("SIGTERM");
      this.config.headless = false;
      await this.launchChrome();
      return ok(undefined);
    } catch (error) {
      return err(new DaemonError(
        `Failed to launch headed browser: ${error instanceof Error ? error.message : String(error)}`,
        "BROWSER_LAUNCH_HEADED_FAILED",
        error instanceof Error ? error : undefined,
      ));
    }
  }

  /**
   * Stop the current Chrome process (if running) and relaunch in headless
   * mode. Watcher cron jobs are intentionally NOT stopped — this is a Chrome
   * restart, not a full service shutdown.
   */
  async launchHeadless(): Promise<Result<void, DaemonError>> {
    try {
      await this.stopChrome("SIGTERM");
      this.config.headless = true;
      await this.launchChrome();
      return ok(undefined);
    } catch (error) {
      return err(new DaemonError(
        `Failed to launch headless browser: ${error instanceof Error ? error.message : String(error)}`,
        "BROWSER_LAUNCH_HEADLESS_FAILED",
        error instanceof Error ? error : undefined,
      ));
    }
  }

  /**
   * Capture a JPEG screenshot of the currently active page and save it to
   * the configured screenshot directory. Returns the absolute file path.
   *
   * Returns an error result if the browser is not running.
   */
  async takeScreenshot(quality: number = 80): Promise<Result<{ path: string }, DaemonError>> {
    const status = this.getStatus();
    if (!status.running) {
      return err(new DaemonError("Browser is not running", "BROWSER_NOT_RUNNING"));
    }

    const client = this.cdpClient as CdpClient;
    const screenshotDir = this.config.screenshotDir
      ?? join(homedir(), ".reins", "browser", "screenshots");

    try {
      const result = await client.send<CaptureScreenshotResult>("Page.captureScreenshot", {
        format: "jpeg",
        quality,
      });

      await mkdir(screenshotDir, { recursive: true });

      const filename = `screenshot-${Date.now()}.jpg`;
      const filePath = join(screenshotDir, filename);
      await Bun.write(filePath, Buffer.from(result.data, "base64"));

      return ok({ path: filePath });
    } catch (error) {
      return err(new DaemonError(
        `Screenshot failed: ${error instanceof Error ? error.message : String(error)}`,
        "SCREENSHOT_FAILED",
        error instanceof Error ? error : undefined,
      ));
    }
  }

  async ensureBrowser(): Promise<CdpClient> {
    if (this.isBrowserHealthy()) {
      return this.cdpClient as CdpClient;
    }

    if (this.launchPromise) {
      return this.launchPromise;
    }

    this.launchPromise = (async () => {
      await this.stopChrome("SIGTERM");
      await this.launchChrome();
      if (!this.cdpClient) {
        throw new BrowserError("Browser launched but CDP client was not initialized");
      }
      return this.cdpClient;
    })();

    try {
      return await this.launchPromise;
    } finally {
      this.launchPromise = null;
    }
  }

  async getActiveCdpClient(): Promise<CdpClient> {
    if (this.isBrowserHealthy()) {
      return this.cdpClient as CdpClient;
    }

    return this.ensureBrowser();
  }

  getStatus(): BrowserStatus {
    if (!this.isBrowserHealthy()) {
      return {
        running: false,
        tabs: [],
        profilePath: this.config.profilePath,
        headless: this.config.headless,
      };
    }

    const process = this.chromeProcess as ReturnType<SpawnFn>;

    return {
      running: true,
      chrome: {
        pid: process.pid ?? 0,
        port: this.config.port,
        webSocketDebuggerUrl: `ws://127.0.0.1:${this.config.port}/devtools/browser`,
        startedAt: this.startedAt ?? Date.now(),
      },
      tabs: this.tabs,
      activeTabId: this.activeTabId,
      profilePath: this.config.profilePath,
      headless: this.config.headless,
      memoryUsageMb: this.getMemoryUsage(),
    };
  }

  updateTabState(tabs: TabInfo[], activeTabId?: string): void {
    const normalizedActiveTabId = activeTabId !== undefined && tabs.some((tab) => tab.tabId === activeTabId)
      ? activeTabId
      : tabs[0]?.tabId;

    this.activeTabId = normalizedActiveTabId;
    this.tabs = tabs.map((tab) => ({
      ...tab,
      active: tab.tabId === normalizedActiveTabId,
    }));
  }

  getCurrentTabId(): string | undefined {
    return this.activeTabId;
  }

  private isBrowserHealthy(): boolean {
    if (!this.chromeProcess || this.processExited) {
      return false;
    }

    return this.cdpClient?.isConnected === true;
  }

  private async launchChrome(): Promise<void> {
    const binary = await this.findBinaryFn();
    const profilePath = this.config.profilePath;
    const port = this.config.port;

    await mkdir(profilePath, { recursive: true });

    const chromeFlags = [
      ...(this.config.headless ? ["--headless=new"] : []),
      ...CHROME_FLAGS,
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profilePath}`,
    ];

    const process = this.spawnFn([binary, ...chromeFlags], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.chromeProcess = process;
    this.processExited = false;
    this.startedAt = Date.now();
    process.exited.then(() => {
      this.processExited = true;
    });

    await this.waitForChromeReady(port, 10_000);

    const client = this.cdpClientFactory(port);
    try {
      await client.connect();
      this.cdpClient = client;
      try {
        await injectStealthScripts(client);
      } catch (e) {
        // Expected: stealth injection is non-fatal — browser control remains available
        log.warn("stealth script injection failed", { error: e instanceof Error ? e.message : String(e) });
      }
    } catch (error) {
      await this.stopChrome("SIGTERM");
      throw error;
    }
  }

  private async stopChrome(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
    const client = this.cdpClient;
    if (client) {
      this.cdpClient = null;
      await client.disconnect();
    }

    const process = this.chromeProcess;
    if (!process) {
      this.tabs = [];
      this.activeTabId = undefined;
      this.startedAt = undefined;
      return;
    }

    process.kill(signal === "SIGTERM" ? 15 : 9);

    const exited = await Promise.race([
      process.exited.then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          clearTimeout(timer);
          resolve(false);
        }, 5_000);
      }),
    ]);

    if (!exited) {
      process.kill(9);
    }

    this.chromeProcess = null;
    this.processExited = true;
    this.tabs = [];
    this.activeTabId = undefined;
    this.startedAt = undefined;
  }

  private async waitForChromeReady(port: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (response.ok) {
          return;
        }
      } catch {
        // Expected: Chrome not ready yet — retry after delay
      }

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          clearTimeout(timer);
          resolve();
        }, 100);
      });
    }

    throw new BrowserError(`Chrome did not start within ${timeoutMs}ms`);
  }

  private getMemoryUsage(): number | undefined {
    if (!this.chromeProcess?.pid) {
      return undefined;
    }

    const platform = process.platform;

    if (platform === "linux") {
      return this.getMemoryUsageLinux(this.chromeProcess.pid);
    }

    if (platform === "darwin") {
      return this.getMemoryUsageDarwin(this.chromeProcess.pid);
    }

    return undefined;
  }

  private getMemoryUsageLinux(pid: number): number | undefined {
    const statusPath = `/proc/${pid}/status`;
    try {
      const content = readFileSync(statusPath, "utf8");
      const vmRssLine = content
        .split("\n")
        .find((line) => line.startsWith("VmRSS:"));
      if (!vmRssLine) {
        return undefined;
      }

      const match = vmRssLine.match(/VmRSS:\s+(\d+)\s+kB/i);
      if (!match) {
        return undefined;
      }

      const kb = Number.parseInt(match[1] ?? "", 10);
      if (!Number.isFinite(kb)) {
        return undefined;
      }

      return Math.round(kb / 1024);
    } catch {
      // Expected: /proc may not be readable or process may have exited
      return undefined;
    }
  }

  private getMemoryUsageDarwin(pid: number): number | undefined {
    try {
      const result = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]);
      const output = result.stdout.toString().trim();
      if (output.length === 0) {
        return undefined;
      }

      const kb = Number.parseInt(output, 10);
      if (!Number.isFinite(kb)) {
        return undefined;
      }

      return Math.round(kb / 1024);
    } catch {
      // Expected: ps command may fail if process has exited
      return undefined;
    }
  }
}
