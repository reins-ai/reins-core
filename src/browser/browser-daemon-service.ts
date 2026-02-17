import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";

import { err, ok, type Result } from "../result";
import { DaemonError, type DaemonManagedService } from "../daemon/types";
import { CdpClient } from "./cdp-client";
import { findChromeBinary } from "./chrome-finder";
import { BrowserError } from "./errors";
import type { BrowserConfig, BrowserStatus, TabInfo } from "./types";

const DEFAULT_CONFIG: BrowserConfig = {
  profilePath: process.env.REINS_BROWSER_PROFILE?.trim() || `${homedir()}/.reins/browser/profiles/default`,
  port: 9222,
  headless: true,
  maxWatchers: 10,
};

const CHROME_FLAGS = [
  "--headless=new",
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
}

export class BrowserDaemonService implements DaemonManagedService {
  readonly id = "browser";

  private static bunSpawnFn: SpawnFn = Bun.spawn;

  private readonly config: BrowserConfig;
  private readonly spawnFn: SpawnFn;
  private readonly findBinaryFn: () => Promise<string>;
  private readonly cdpClientFactory: (port: number) => CdpClient;

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
  }

  static _setBunSpawnForTests(fn: typeof Bun.spawn): void {
    BrowserDaemonService.bunSpawnFn = fn;
  }

  static _resetBunSpawnForTests(): void {
    BrowserDaemonService.bunSpawnFn = Bun.spawn;
  }

  async start(): Promise<Result<void, DaemonError>> {
    return ok(undefined);
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<Result<void, DaemonError>> {
    try {
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
        // Chrome not ready yet.
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
    if (!this.chromeProcess?.pid || process.platform !== "linux") {
      return undefined;
    }

    const statusPath = `/proc/${this.chromeProcess.pid}/status`;
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
      return undefined;
    }
  }
}
