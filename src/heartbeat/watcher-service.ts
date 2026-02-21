import { join } from "node:path";

import { err, ok } from "../result";
import { createLogger } from "../logger";
import { DaemonError, type DaemonManagedService, type DaemonResult } from "../daemon/types";
import { RoutineDueEvaluator, type DueRoutine, type Routine } from "./routines";

export const HEARTBEAT_WATCHER_MIN_DEBOUNCE_MS = 30_000;

interface HeartbeatFileWatcher {
  close(): void;
}

interface HeartbeatWatcherLogger {
  info(message: string, details?: Record<string, unknown>): void;
  warn(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

export interface HeartbeatWatcherServiceOptions {
  workspacePath: string;
  debounceMs?: number;
  routineEvaluator?: RoutineDueEvaluator;
  readFile?: (path: string) => Promise<string>;
  watchFile?: (path: string, onChange: () => void) => HeartbeatFileWatcher;
  setTimeoutFn?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  clearTimeoutFn?: (timeout: ReturnType<typeof setTimeout>) => void;
  now?: () => Date;
  logger?: HeartbeatWatcherLogger;
}

const _moduleLog = createLogger("heartbeat");

const defaultLogger: HeartbeatWatcherLogger = {
  info: (message, details) => {
    _moduleLog.info(message, details);
  },
  warn: (message, details) => {
    _moduleLog.warn(message, details);
  },
  error: (message, details) => {
    _moduleLog.error(message, details);
  },
};

type BunWatchResult =
  | {
      stop?: () => void;
      close?: () => void;
    }
  | (() => void)
  | void;

interface BunWatchableFile {
  watch?: (callback: (event: unknown) => void) => BunWatchResult;
}

function createBunFileWatcher(path: string, onChange: () => void): HeartbeatFileWatcher {
  const watchableFile = Bun.file(path) as unknown as BunWatchableFile;
  if (typeof watchableFile.watch !== "function") {
    throw new DaemonError(
      "Bun.file().watch() is unavailable for heartbeat watcher",
      "HEARTBEAT_WATCH_UNSUPPORTED",
    );
  }

  const watchResult = watchableFile.watch(() => {
    onChange();
  });

  if (typeof watchResult === "function") {
    return {
      close: watchResult,
    };
  }

  if (watchResult && typeof watchResult === "object") {
    if (typeof watchResult.stop === "function") {
      return {
        close: () => {
          watchResult.stop?.();
        },
      };
    }

    if (typeof watchResult.close === "function") {
      return {
        close: () => {
          watchResult.close?.();
        },
      };
    }
  }

  throw new DaemonError(
    "Bun.file().watch() returned an unsupported watcher handle",
    "HEARTBEAT_WATCH_HANDLE_UNSUPPORTED",
  );
}

/**
 * Daemon-managed heartbeat watcher that tracks HEARTBEAT.md changes,
 * debounces file churn, and exposes parsed routines for scheduled execution.
 */
export class HeartbeatWatcherService implements DaemonManagedService {
  readonly id = "heartbeat-watcher";

  private readonly heartbeatPath: string;
  private readonly debounceMs: number;
  private readonly routineEvaluator: RoutineDueEvaluator;
  private readonly readFile: (path: string) => Promise<string>;
  private readonly watchFile: (path: string, onChange: () => void) => HeartbeatFileWatcher;
  private readonly setTimeoutFn: (
    callback: () => void,
    timeoutMs: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimeoutFn: (timeout: ReturnType<typeof setTimeout>) => void;
  private readonly now: () => Date;
  private readonly logger: HeartbeatWatcherLogger;

  private watcher: HeartbeatFileWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;

  constructor(options: HeartbeatWatcherServiceOptions) {
    this.heartbeatPath = join(options.workspacePath, "HEARTBEAT.md");
    this.debounceMs = Math.max(options.debounceMs ?? HEARTBEAT_WATCHER_MIN_DEBOUNCE_MS, HEARTBEAT_WATCHER_MIN_DEBOUNCE_MS);
    this.routineEvaluator = options.routineEvaluator ?? new RoutineDueEvaluator();
    this.readFile = options.readFile ?? defaultReadHeartbeatFile;
    this.watchFile = options.watchFile ?? createBunFileWatcher;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? defaultLogger;

    if ((options.debounceMs ?? HEARTBEAT_WATCHER_MIN_DEBOUNCE_MS) < HEARTBEAT_WATCHER_MIN_DEBOUNCE_MS) {
      this.logger.warn("Heartbeat watcher debounce below minimum; clamped to 30s", {
        requestedMs: options.debounceMs,
        appliedMs: this.debounceMs,
      });
    }
  }

  async start(): Promise<DaemonResult<void>> {
    if (this.started) {
      return ok(undefined);
    }

    await this.parseHeartbeatFile("startup");

    try {
      this.watcher = this.watchFile(this.heartbeatPath, () => {
        this.scheduleDebouncedParse();
      });
    } catch (error) {
      return err(
        new DaemonError(
          error instanceof Error ? error.message : "Unable to initialize heartbeat file watcher",
          "HEARTBEAT_WATCH_INIT_FAILED",
          error instanceof Error ? error : undefined,
        ),
      );
    }

    this.started = true;
    this.logger.info("Heartbeat watcher started", {
      path: this.heartbeatPath,
      debounceMs: this.debounceMs,
    });

    return ok(undefined);
  }

  async stop(_signal?: NodeJS.Signals): Promise<DaemonResult<void>> {
    if (this.debounceTimer) {
      this.clearTimeoutFn(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (error) {
        return err(
          new DaemonError(
            error instanceof Error ? error.message : "Unable to close heartbeat watcher",
            "HEARTBEAT_WATCH_STOP_FAILED",
            error instanceof Error ? error : undefined,
          ),
        );
      }
      this.watcher = null;
    }

    this.started = false;
    this.logger.info("Heartbeat watcher stopped", {
      path: this.heartbeatPath,
    });

    return ok(undefined);
  }

  getTasks(): Routine[] {
    return this.routineEvaluator.getRoutines();
  }

  getDueTasks(lastHeartbeat?: Date, now: Date = this.now()): DueRoutine[] {
    return this.routineEvaluator.evaluateDue(now, lastHeartbeat);
  }

  private scheduleDebouncedParse(): void {
    if (this.debounceTimer) {
      this.clearTimeoutFn(this.debounceTimer);
      this.debounceTimer = null;
    }

    this.debounceTimer = this.setTimeoutFn(() => {
      this.debounceTimer = null;
      void this.parseHeartbeatFile("watch-update");
    }, this.debounceMs);
  }

  private async parseHeartbeatFile(source: "startup" | "watch-update"): Promise<void> {
    try {
      const content = await this.readFile(this.heartbeatPath);
      this.routineEvaluator.loadRoutines(content);
      this.logger.info("Heartbeat routines parsed", {
        path: this.heartbeatPath,
        source,
        routineCount: this.routineEvaluator.getRoutines().length,
      });
    } catch (error) {
      this.routineEvaluator.loadRoutines("");
      this.logger.warn("Heartbeat parse failed; loaded empty routine set", {
        path: this.heartbeatPath,
        source,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

async function defaultReadHeartbeatFile(path: string): Promise<string> {
  return Bun.file(path).text();
}
