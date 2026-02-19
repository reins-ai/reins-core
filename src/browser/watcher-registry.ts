import type { BrowserDaemonService } from "./browser-daemon-service";
import { BrowserError } from "./errors";
import type { SnapshotEngine } from "./snapshot";
import type { WatcherConfig, WatcherState } from "./types";
import { BrowserWatcher } from "./watcher";

const DEFAULT_MAX_WATCHERS = 10;
const DEFAULT_INTERVAL_SECONDS = 300;
const DEFAULT_MAX_TOKENS = 2_000;

export interface WatcherRegistryOptions {
  snapshotEngine: SnapshotEngine;
  browserService: BrowserDaemonService;
  maxWatchers?: number;
}

export class WatcherRegistry {
  private readonly watchers = new Map<string, BrowserWatcher>();
  private nextId = 1;

  readonly maxWatchers: number;

  constructor(
    private readonly options: WatcherRegistryOptions,
  ) {
    this.maxWatchers = options.maxWatchers ?? DEFAULT_MAX_WATCHERS;
  }

  async register(config: WatcherConfig): Promise<BrowserWatcher> {
    if (this.watchers.size >= this.maxWatchers) {
      throw new BrowserError(`Watcher limit exceeded: maximum ${this.maxWatchers} watchers allowed`);
    }

    const watcherId = this.resolveWatcherId(config.id);
    if (this.watchers.has(watcherId)) {
      throw new BrowserError(`Watcher already exists: ${watcherId}`);
    }

    const normalizedConfig: WatcherConfig = {
      id: watcherId,
      url: config.url,
      intervalSeconds: this.resolveInterval(config.intervalSeconds),
      format: config.format ?? "compact",
      filter: config.filter ?? "interactive",
      maxTokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
      createdAt: config.createdAt > 0 ? config.createdAt : Date.now(),
    };

    const watcher = new BrowserWatcher(
      normalizedConfig,
      this.options.snapshotEngine,
      this.options.browserService,
    );

    await watcher.takeBaseline();
    this.watchers.set(watcher.id, watcher);
    return watcher;
  }

  get(id: string): BrowserWatcher | undefined {
    return this.watchers.get(id);
  }

  list(): BrowserWatcher[] {
    return Array.from(this.watchers.values());
  }

  remove(id: string): boolean {
    return this.watchers.delete(id);
  }

  deserialize(states: WatcherState[]): void {
    this.watchers.clear();

    for (const state of states) {
      const watcher = BrowserWatcher.deserialize(
        state,
        this.options.snapshotEngine,
        this.options.browserService,
      );
      this.watchers.set(state.config.id, watcher);
      this.captureNextId(state.config.id);
    }
  }

  private resolveWatcherId(requestedId: string): string {
    const trimmed = requestedId.trim();
    if (trimmed.length === 0) {
      return this.generateId();
    }

    this.captureNextId(trimmed);
    return trimmed;
  }

  private resolveInterval(intervalSeconds: number): number {
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      return DEFAULT_INTERVAL_SECONDS;
    }

    if (!Number.isInteger(intervalSeconds) || intervalSeconds < 60) {
      throw new BrowserError("Watcher intervalSeconds must be an integer of at least 60 seconds");
    }

    return intervalSeconds;
  }

  private generateId(): string {
    const id = `watcher-${String(this.nextId).padStart(3, "0")}`;
    this.nextId += 1;
    return id;
  }

  private captureNextId(id: string): void {
    const match = id.match(/^watcher-(\d+)$/);
    if (!match) {
      return;
    }

    const parsed = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(parsed) && parsed >= this.nextId) {
      this.nextId = parsed + 1;
    }
  }
}
