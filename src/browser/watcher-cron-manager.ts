import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { createLogger } from "../logger";
import type { CronScheduler } from "../cron/scheduler";
import type { CronJobCreateInput } from "../cron/types";
import type { BrowserDaemonService } from "./browser-daemon-service";
import type { NotificationDelivery } from "./conversation-notification-delivery";
import type { SnapshotEngine } from "./snapshot";
import type { WatcherConfig, WatcherState } from "./types";
import { BrowserWatcher } from "./watcher";
import { WatcherRegistry } from "./watcher-registry";

export interface WatcherPersistenceIO {
  readFile: typeof readFile;
  writeFile: typeof writeFile;
  rename: typeof rename;
  mkdir: typeof mkdir;
}

export interface WatcherCronManagerOptions {
  snapshotEngine: SnapshotEngine;
  browserService: BrowserDaemonService;
  cronScheduler: CronScheduler;
  notificationDelivery?: NotificationDelivery;
  maxWatchers?: number;
  watchersFilePath?: string;
  persistenceIO?: WatcherPersistenceIO;
}

const log = createLogger("browser:watcher");

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

function defaultWatchersFilePath(): string {
  return process.env.REINS_BROWSER_WATCHERS_FILE?.trim()
    || join(homedir(), ".reins", "browser", "watchers.json");
}

export class WatcherCronManager {
  private readonly registry: WatcherRegistry;
  private readonly cronScheduler: CronScheduler;
  private readonly notificationDelivery?: NotificationDelivery;
  private readonly watchersFilePath: string;
  private readonly io: WatcherPersistenceIO;

  constructor(options: WatcherCronManagerOptions) {
    this.registry = new WatcherRegistry({
      snapshotEngine: options.snapshotEngine,
      browserService: options.browserService,
      maxWatchers: options.maxWatchers,
    });
    this.cronScheduler = options.cronScheduler;
    this.notificationDelivery = options.notificationDelivery;
    this.watchersFilePath = options.watchersFilePath ?? defaultWatchersFilePath();
    this.io = options.persistenceIO ?? { readFile, writeFile, rename, mkdir };
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

    await this.saveWatchers();
    return watcher;
  }

  async removeWatcher(id: string): Promise<void> {
    this.registry.remove(id);
    await this.cronScheduler.remove(cronJobId(id));
    await this.saveWatchers();
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
      const diff = await watcher.checkForChanges();

      if (diff.hasChanges && this.notificationDelivery) {
        const config = watcher.state.config;
        try {
          await this.notificationDelivery.sendWatcherNotification(
            watcherId,
            config.url,
            diff,
          );
        } catch (e) {
          // Expected: notification delivery errors must never disrupt cron execution
          log.warn("watcher notification delivery failed", { watcherId, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } catch (e) {
      // Expected: error is already recorded on the watcher via markError() in
      // BrowserWatcher.checkForChanges(). Swallowed so the cron scheduler is never disrupted.
      log.debug("watcher check error (already recorded on watcher)", { watcherId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  /**
   * Resume watchers from persisted state on disk.
   * Called during daemon startup to restore watchers that survived a restart.
   * Never throws — corrupt or missing files are handled gracefully.
   */
  async resumeWatchers(): Promise<void> {
    let states: WatcherState[];
    try {
      const raw = await this.io.readFile(this.watchersFilePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        log.warn("watchers.json is not an array, starting with empty registry");
        return;
      }
      states = parsed as WatcherState[];
    } catch (error) {
      if (isFileNotFoundError(error)) {
        return;
      }
      log.warn("Failed to load watchers", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    this.registry.deserialize(states);

    for (const watcher of this.registry.list()) {
      const cronInput: CronJobCreateInput = {
        id: cronJobId(watcher.id),
        name: `Watcher: ${watcher.id}`,
        schedule: intervalToCron(watcher.state.config.intervalSeconds),
        payload: {
          action: "watcher-check",
          parameters: { watcherId: watcher.id },
        },
      };

      try {
        const result = await this.cronScheduler.create(cronInput);
        if (!result.ok) {
          log.warn("Failed to schedule resumed watcher", {
            watcherId: watcher.id,
            error: result.error.message,
          });
        }
      } catch (error) {
        log.warn("Failed to schedule resumed watcher", {
          watcherId: watcher.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Stop all active cron jobs for watchers.
   * Called during daemon shutdown to clean up scheduled jobs.
   */
  async stopAllCronJobs(): Promise<void> {
    for (const watcher of this.registry.list()) {
      try {
        await this.cronScheduler.remove(cronJobId(watcher.id));
      } catch (e) {
        // Expected: best-effort cleanup — don't crash on individual removal failures
        log.debug("failed to remove watcher cron job during shutdown", { watcherId: watcher.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
  }

  private async saveWatchers(): Promise<void> {
    try {
      const states = this.registry.list().map((watcher) => watcher.serialize());
      const json = JSON.stringify(states, null, 2);
      const dir = dirname(this.watchersFilePath);
      await this.io.mkdir(dir, { recursive: true });
      const tmpPath = `${this.watchersFilePath}.tmp`;
      await this.io.writeFile(tmpPath, json, "utf8");
      await this.io.rename(tmpPath, this.watchersFilePath);
    } catch (e) {
      // Expected: persistence errors must never crash the watcher system
      log.warn("failed to persist watcher state", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}
