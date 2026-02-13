import { watch, type FSWatcher } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { err, ok, type Result } from "../../result";
import { ReinsError } from "../../errors";
import type { MemoryFileIngestor, ScanReport } from "./memory-file-ingestor";

export class MemoryWatcherError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "MEMORY_WATCHER_ERROR", cause);
    this.name = "MemoryWatcherError";
  }
}

export type RescanReport = ScanReport;

const IGNORED_EXTENSIONS = new Set([".tmp", ".swp", ".swo", ".bak", ".crswap"]);
const IGNORED_PREFIXES = [".", "~", "#"];

function shouldIgnoreFile(fileName: string): boolean {
  if (!fileName.endsWith(".md")) return true;

  for (const prefix of IGNORED_PREFIXES) {
    if (fileName.startsWith(prefix)) return true;
  }

  for (const ext of IGNORED_EXTENSIONS) {
    if (fileName.endsWith(ext) || fileName.endsWith(`${ext}.md`)) return true;
  }

  return false;
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

export interface MemoryFileWatcherOptions {
  dataDir: string;
  ingestor: MemoryFileIngestor;
  debounceMs?: number;
  logger?: {
    warn(message: string): void;
    info(message: string): void;
    error(message: string): void;
  };
}

export class MemoryFileWatcher {
  private readonly dataDir: string;
  private readonly ingestor: MemoryFileIngestor;
  private readonly debounceMs: number;
  private readonly logger?: MemoryFileWatcherOptions["logger"];

  private watcher: FSWatcher | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(options: MemoryFileWatcherOptions) {
    this.dataDir = options.dataDir;
    this.ingestor = options.ingestor;
    this.debounceMs = options.debounceMs ?? 500;
    this.logger = options.logger;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<Result<void>> {
    if (this.running) {
      return ok(undefined);
    }

    try {
      // Verify directory exists before watching
      const dirStat = await stat(this.dataDir);
      if (!dirStat.isDirectory()) {
        return err(
          new MemoryWatcherError(`Data directory is not a directory: ${this.dataDir}`),
        );
      }
    } catch (cause) {
      const error = asError(cause);
      if (error && "code" in error && error.code === "ENOENT") {
        return err(
          new MemoryWatcherError(`Data directory does not exist: ${this.dataDir}`),
        );
      }

      return err(
        new MemoryWatcherError(
          `Failed to verify data directory: ${this.dataDir}`,
          error,
        ),
      );
    }

    try {
      this.watcher = watch(this.dataDir, { persistent: false }, (eventType, fileName) => {
        if (!fileName || shouldIgnoreFile(fileName)) return;
        this.scheduleIngest(fileName, eventType);
      });

      this.watcher.on("error", (watchError) => {
        this.logger?.error(`File watcher error: ${watchError.message}`);
      });

      this.running = true;
      this.logger?.info(`File watcher started on: ${this.dataDir}`);
      return ok(undefined);
    } catch (cause) {
      return err(
        new MemoryWatcherError(
          `Failed to start file watcher on: ${this.dataDir}`,
          asError(cause),
        ),
      );
    }
  }

  async stop(): Promise<Result<void>> {
    if (!this.running) {
      return ok(undefined);
    }

    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      try {
        this.watcher.close();
      } catch (cause) {
        return err(
          new MemoryWatcherError(
            "Failed to close file watcher",
            asError(cause),
          ),
        );
      }
      this.watcher = null;
    }

    this.running = false;
    this.logger?.info("File watcher stopped");
    return ok(undefined);
  }

  async rescan(): Promise<Result<RescanReport>> {
    const result = await this.ingestor.scanDirectory(this.dataDir);
    if (!result.ok) {
      return err(
        new MemoryWatcherError(
          "Rescan failed",
          result.error,
        ),
      );
    }

    this.logger?.info(
      `Rescan complete: ${result.value.totalFiles} files, ` +
      `${result.value.ingested} ingested, ${result.value.updated} updated, ` +
      `${result.value.skipped} skipped, ${result.value.quarantined} quarantined`,
    );

    return ok(result.value);
  }

  private scheduleIngest(fileName: string, eventType: string): void {
    // Cancel any pending debounce for this file
    const existing = this.debounceTimers.get(fileName);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(fileName);
      void this.processFileEvent(fileName, eventType);
    }, this.debounceMs);

    this.debounceTimers.set(fileName, timer);
  }

  private async processFileEvent(fileName: string, eventType: string): Promise<void> {
    const filePath = join(this.dataDir, fileName);

    // Check if file still exists (could be a deletion)
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) return;
    } catch (cause) {
      const error = asError(cause);
      if (error && "code" in error && error.code === "ENOENT") {
        // File was deleted
        const deleteResult = await this.ingestor.handleDeletion(filePath);
        if (!deleteResult.ok) {
          this.logger?.error(`Failed to handle deletion of ${fileName}: ${deleteResult.error.message}`);
        }
        return;
      }

      this.logger?.error(`Failed to stat ${fileName}: ${String(cause)}`);
      return;
    }

    const result = await this.ingestor.ingestFile(filePath);
    if (!result.ok) {
      this.logger?.error(`Failed to ingest ${fileName}: ${result.error.message}`);
      return;
    }

    if (result.value.action !== "skipped") {
      this.logger?.info(
        `File event '${eventType}' on ${fileName}: ${result.value.action}` +
        (result.value.memoryId ? ` (${result.value.memoryId})` : ""),
      );
    }
  }
}
