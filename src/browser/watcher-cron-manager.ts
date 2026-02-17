import type { CronScheduler } from "../cron/scheduler";
import type { CronJobCreateInput } from "../cron/types";
import type { BrowserDaemonService } from "./browser-daemon-service";
import type { SnapshotEngine } from "./snapshot";
import type { WatcherConfig } from "./types";
import { BrowserWatcher } from "./watcher";
import { WatcherRegistry } from "./watcher-registry";

export interface WatcherCronManagerOptions {
  snapshotEngine: SnapshotEngine;
  browserService: BrowserDaemonService;
  cronScheduler: CronScheduler;
  maxWatchers?: number;
}

const CRON_JOB_PREFIX = "watcher-cron-";

/**
 * Convert an interval in seconds to a 5-field cron expression.
 *
 * - 60s  → `"* * * * *"` (every minute)
 * - 300s → `"*​/5 * * * *"` (every 5 minutes)
 * - 3600s → `"0 * * * *"` (every hour)
 * - General: seconds → minutes, then `"*​/M * * * *"` or `"0 *​/H * * *"`
 */
export function intervalToCron(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) {
    return "* * * * *";
  }

  const minutes = Math.ceil(seconds / 60);

  if (minutes === 1) {
    return "* * * * *";
  }

  if (minutes < 60) {
    return `*/${minutes} * * * *`;
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours === 1) {
      return "0 * * * *";
    }
    return `0 */${hours} * * *`;
  }

  const roundedMinutes = Math.min(minutes, 59);
  return `*/${roundedMinutes} * * * *`;
}

function cronJobId(watcherId: string): string {
  return `${CRON_JOB_PREFIX}${watcherId}`;
}

function watcherIdFromCronJobId(jobId: string): string | undefined {
  if (!jobId.startsWith(CRON_JOB_PREFIX)) {
    return undefined;
  }
  return jobId.slice(CRON_JOB_PREFIX.length);
}

export class WatcherCronManager {
  private readonly registry: WatcherRegistry;
  private readonly cronScheduler: CronScheduler;

  constructor(options: WatcherCronManagerOptions) {
    this.registry = new WatcherRegistry({
      snapshotEngine: options.snapshotEngine,
      browserService: options.browserService,
      maxWatchers: options.maxWatchers,
    });
    this.cronScheduler = options.cronScheduler;
  }

  async createWatcher(config: WatcherConfig): Promise<BrowserWatcher> {
    const watcher = await this.registry.register(config);

    const cronInput: CronJobCreateInput = {
      id: cronJobId(watcher.id),
      name: `Watcher: ${watcher.id}`,
      schedule: intervalToCron(config.intervalSeconds),
      payload: {
        action: "watcher-check",
        parameters: { watcherId: watcher.id },
      },
    };

    const result = await this.cronScheduler.create(cronInput);
    if (!result.ok) {
      this.registry.remove(watcher.id);
      throw result.error;
    }

    return watcher;
  }

  async removeWatcher(id: string): Promise<void> {
    this.registry.remove(id);
    await this.cronScheduler.remove(cronJobId(id));
  }

  getWatcher(id: string): BrowserWatcher | undefined {
    return this.registry.get(id);
  }

  listWatchers(): BrowserWatcher[] {
    return this.registry.list();
  }

  /**
   * Handle a cron job execution for a watcher.
   * This method is intended to be called from the CronScheduler's `onExecute`
   * callback. It NEVER throws — errors are caught and recorded on the watcher.
   */
  async handleCronExecution(jobId: string): Promise<void> {
    const watcherId = watcherIdFromCronJobId(jobId);
    if (watcherId === undefined) {
      return;
    }

    const watcher = this.registry.get(watcherId);
    if (watcher === undefined) {
      return;
    }

    try {
      await watcher.checkForChanges();
    } catch {
      // Error is already recorded on the watcher via markError() in
      // BrowserWatcher.checkForChanges(). We swallow the re-thrown error
      // here so the cron scheduler is never disrupted.
    }
  }
}
