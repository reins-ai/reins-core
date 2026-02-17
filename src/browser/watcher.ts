import { BrowserError } from "./errors";
import type { BrowserDaemonService } from "./browser-daemon-service";
import type { CdpClient } from "./cdp-client";
import type { SnapshotEngine } from "./snapshot";
import type {
  AttachToTargetResult,
  CdpTargetInfo,
  CreateTargetResult,
  GetTargetsResult,
  Snapshot,
  SnapshotDiff,
  WatcherConfig,
  WatcherDiff,
  WatcherState,
  WatcherStatus,
} from "./types";

interface ResolvedTab {
  tabId: string;
  title: string;
  sessionId: string;
}

export class BrowserWatcher {
  private status: WatcherStatus;
  private baselineSnapshot?: string;
  private baselineData?: Snapshot;
  private lastDiff?: WatcherDiff;
  private lastCheckedAt?: number;
  private lastError?: string;

  constructor(
    private readonly config: WatcherConfig,
    private readonly snapshotEngine: SnapshotEngine,
    private readonly browserService: BrowserDaemonService,
    initialState?: Omit<WatcherState, "config">,
  ) {
    this.validateInterval(config.intervalSeconds);
    this.status = initialState?.status ?? "active";
    this.baselineSnapshot = initialState?.baselineSnapshot;
    this.lastDiff = initialState?.lastDiff;
    this.lastCheckedAt = initialState?.lastCheckedAt;
    this.lastError = initialState?.lastError;
  }

  get id(): string {
    return this.config.id;
  }

  get state(): WatcherState {
    return this.serialize();
  }

  async takeBaseline(): Promise<string> {
    this.ensureActive();

    try {
      const snapshot = await this.captureSnapshot();
      this.baselineData = snapshot;
      this.baselineSnapshot = this.snapshotEngine.serializeSnapshot(snapshot, this.config.format);
      this.lastCheckedAt = Date.now();
      this.lastError = undefined;
      return this.baselineSnapshot;
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  async checkForChanges(): Promise<WatcherDiff> {
    this.ensureActive();

    if (this.baselineData === undefined) {
      throw new BrowserError(`Watcher ${this.config.id} has no baseline snapshot`);
    }

    try {
      const currentSnapshot = await this.captureSnapshot();
      const diff = this.snapshotEngine.computeDiff(this.baselineData, currentSnapshot);
      const watcherDiff = this.mapDiff(diff);
      this.lastDiff = watcherDiff;
      this.lastCheckedAt = watcherDiff.timestamp;
      this.lastError = undefined;
      return watcherDiff;
    } catch (error) {
      this.markError(error);
      throw error;
    }
  }

  pause(): void {
    this.status = "paused";
  }

  resume(): void {
    if (this.status === "error") {
      this.lastError = undefined;
    }
    this.status = "active";
  }

  serialize(): WatcherState {
    return {
      config: { ...this.config },
      status: this.status,
      baselineSnapshot: this.baselineSnapshot,
      lastDiff: this.lastDiff,
      lastCheckedAt: this.lastCheckedAt,
      lastError: this.lastError,
    };
  }

  static deserialize(
    state: WatcherState,
    snapshotEngine: SnapshotEngine,
    browserService: BrowserDaemonService,
  ): BrowserWatcher {
    return new BrowserWatcher(state.config, snapshotEngine, browserService, {
      status: state.status,
      baselineSnapshot: state.baselineSnapshot,
      lastDiff: state.lastDiff,
      lastCheckedAt: state.lastCheckedAt,
      lastError: state.lastError,
    });
  }

  private async captureSnapshot(): Promise<Snapshot> {
    const client = await this.browserService.ensureBrowser();
    const tab = await this.resolveTab(client);

    await client.send("Page.enable", undefined, tab.sessionId);
    await client.send("Page.navigate", { url: this.config.url }, tab.sessionId);

    return this.snapshotEngine.takeSnapshot({
      cdpClient: client,
      tabId: tab.tabId,
      url: this.config.url,
      title: tab.title,
      sessionId: tab.sessionId,
      options: {
        format: this.config.format,
        filter: this.config.filter,
        maxTokens: this.config.maxTokens,
      },
    });
  }

  private async resolveTab(client: CdpClient): Promise<ResolvedTab> {
    const currentTabId = this.browserService.getCurrentTabId();
    const targets = await client.send<GetTargetsResult>("Target.getTargets");

    const currentTarget = currentTabId
      ? targets.targetInfos.find((target) => target.type === "page" && target.targetId === currentTabId)
      : undefined;

    const pageTarget = currentTarget ?? targets.targetInfos.find((target) => target.type === "page");

    const target = pageTarget ?? await this.createBlankTab(client);
    const attached = await client.send<AttachToTargetResult>("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: true,
    });

    return {
      tabId: target.targetId,
      title: target.title || this.config.url,
      sessionId: attached.sessionId,
    };
  }

  private async createBlankTab(client: CdpClient): Promise<CdpTargetInfo> {
    const created = await client.send<CreateTargetResult>("Target.createTarget", { url: "about:blank" });
    return {
      targetId: created.targetId,
      type: "page",
      title: "about:blank",
      url: "about:blank",
      attached: false,
    };
  }

  private mapDiff(diff: SnapshotDiff): WatcherDiff {
    const timestamp = Date.now();
    const added = diff.added.map((node) => this.nodeLabel(node.ref, node.role, node.name));
    const changed = diff.changed.map((node) => this.nodeLabel(node.ref, node.role, node.name));
    const removed = diff.removed.map((node) => this.nodeLabel(node.ref, node.role, node.name));

    return {
      added,
      changed,
      removed,
      timestamp,
      hasChanges: added.length > 0 || changed.length > 0 || removed.length > 0,
    };
  }

  private nodeLabel(ref: string, role: string, name?: string): string {
    if (name && name.length > 0) {
      return `${ref}:${role} \"${name}\"`;
    }

    return `${ref}:${role}`;
  }

  private ensureActive(): void {
    if (this.status === "paused") {
      throw new BrowserError(`Watcher ${this.config.id} is paused`);
    }
  }

  private markError(error: unknown): void {
    this.status = "error";
    this.lastError = error instanceof Error ? error.message : String(error);
  }

  private validateInterval(intervalSeconds: number): void {
    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60) {
      throw new BrowserError("Watcher intervalSeconds must be an integer of at least 60 seconds");
    }
  }
}
