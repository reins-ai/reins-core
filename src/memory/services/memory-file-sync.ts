import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

import { err, ok, type Result } from "../../result";
import { DaemonError, type DaemonManagedService } from "../../daemon/types";
import type { MemoryFileWatcher } from "../io/memory-file-watcher";
import type { MemoryFileIngestor } from "../io/memory-file-ingestor";
import { serialize } from "../io/markdown-memory-codec";
import { FRONTMATTER_VERSION } from "../io/frontmatter-schema";
import type { MemoryEvent } from "../types/memory-events";
import type { MemoryRecord } from "../types/memory-record";

const DEFAULT_MEMORIES_DIR = join(
  homedir(),
  ".reins",
  "environments",
  "default",
  "memories",
);

export interface MemoryFileSyncLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface MemoryFileSyncOptions {
  watcher: MemoryFileWatcher;
  ingestor: MemoryFileIngestor;
  memoriesDir?: string;
  logger?: MemoryFileSyncLogger;
}

function memoryRecordToFileRecord(record: MemoryRecord) {
  return {
    id: record.id,
    version: FRONTMATTER_VERSION,
    type: record.type,
    layer: record.layer,
    importance: record.importance,
    confidence: record.confidence,
    tags: record.tags,
    entities: record.entities,
    source: {
      type: record.provenance.sourceType,
      conversationId: record.provenance.conversationId,
    },
    supersedes: record.supersedes ?? null,
    supersededBy: record.supersededBy ?? null,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    accessedAt: record.accessedAt.toISOString(),
    content: record.content,
  };
}

function sanitizeFileName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export class MemoryFileSyncService implements DaemonManagedService {
  readonly id = "memory-file-sync";

  private readonly watcher: MemoryFileWatcher;
  private readonly ingestor: MemoryFileIngestor;
  private readonly memoriesDir: string;
  private readonly logger?: MemoryFileSyncLogger;
  private running = false;

  constructor(options: MemoryFileSyncOptions) {
    this.watcher = options.watcher;
    this.ingestor = options.ingestor;
    this.memoriesDir = options.memoriesDir ?? DEFAULT_MEMORIES_DIR;
    this.logger = options.logger;
  }

  async start(): Promise<Result<void, DaemonError>> {
    if (this.running) {
      return ok(undefined);
    }

    try {
      await mkdir(this.memoriesDir, { recursive: true });
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.logger?.error(`Failed to create memories directory: ${error.message}`);
      return err(
        new DaemonError(
          `Failed to create memories directory: ${this.memoriesDir}`,
          "MEMORY_FILE_SYNC_DIR_ERROR",
          error,
        ),
      );
    }

    try {
      const scanResult = await this.ingestor.scanDirectory(this.memoriesDir);
      if (!scanResult.ok) {
        this.logger?.warn(`Initial ingestion failed: ${scanResult.error.message}`);
      } else {
        this.logger?.info(
          `Initial ingestion complete: ${scanResult.value.totalFiles} files, ` +
          `${scanResult.value.ingested} ingested, ${scanResult.value.updated} updated, ` +
          `${scanResult.value.skipped} skipped`,
        );
      }
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.logger?.warn(`Initial ingestion threw unexpectedly: ${error.message}`);
    }

    const watchResult = await this.watcher.start();
    if (!watchResult.ok) {
      this.logger?.error(`Failed to start file watcher: ${watchResult.error.message}`);
      return err(
        new DaemonError(
          `Failed to start file watcher`,
          "MEMORY_FILE_SYNC_WATCHER_ERROR",
          watchResult.error,
        ),
      );
    }

    this.running = true;
    this.logger?.info(`MemoryFileSyncService started (dir: ${this.memoriesDir})`);
    return ok(undefined);
  }

  async stop(): Promise<Result<void, DaemonError>> {
    if (!this.running) {
      return ok(undefined);
    }

    const stopResult = await this.watcher.stop();
    if (!stopResult.ok) {
      this.logger?.error(`Failed to stop file watcher: ${stopResult.error.message}`);
      return err(
        new DaemonError(
          "Failed to stop file watcher",
          "MEMORY_FILE_SYNC_WATCHER_ERROR",
          stopResult.error,
        ),
      );
    }

    this.running = false;
    this.logger?.info("MemoryFileSyncService stopped");
    return ok(undefined);
  }

  get isRunning(): boolean {
    return this.running;
  }

  get dir(): string {
    return this.memoriesDir;
  }

  async handleMemoryEvent(event: MemoryEvent): Promise<void> {
    if (event.type !== "created") {
      return;
    }

    try {
      const fileRecord = memoryRecordToFileRecord(event.record);
      const markdown = serialize(fileRecord);
      const fileName = `${sanitizeFileName(event.record.id)}.md`;
      const filePath = join(this.memoriesDir, fileName);
      await writeFile(filePath, markdown, "utf8");
      this.logger?.info(`Wrote memory file: ${fileName}`);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      this.logger?.error(`Failed to write memory file for ${event.record.id}: ${error.message}`);
    }
  }
}
