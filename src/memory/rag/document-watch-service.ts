import { isAbsolute, relative, resolve } from "node:path";

import { MemoryError } from "../services/memory-error";
import { err, ok, type Result } from "../../result";
import type { DocumentIndexer } from "./document-indexer";
import type { DocumentSourceRegistry } from "./document-source-registry";
import { matchesPolicy } from "./document-source-policy";

export const FILE_CHANGE_TYPES = ["add", "update", "delete"] as const;

export type FileChangeType = (typeof FILE_CHANGE_TYPES)[number];

export interface FileChangeEvent {
  type: FileChangeType;
  filePath: string;
  sourceId: string;
  timestamp: string;
}

export interface WatchServiceConfig {
  debounceMs: number;
  maxQueueSize: number;
  processIntervalMs: number;
}

export const DEFAULT_WATCH_CONFIG: WatchServiceConfig = {
  debounceMs: 500,
  maxQueueSize: 1000,
  processIntervalMs: 2000,
};

export interface ProcessResult {
  processed: number;
  errors: number;
}

export interface FileSystemSnapshot {
  path: string;
  size: number;
  mtimeMs: number;
}

/**
 * Filesystem abstraction for restart recovery.
 * Allows testing without real filesystem access.
 */
export interface WatchServiceFileSystem {
  listFiles(rootPath: string, maxDepth: number): Promise<Result<FileSystemSnapshot[], MemoryError>>;
}

/**
 * Manages an incremental update queue for document index changes.
 *
 * This service handles the logical queue and processing layer for file
 * add/update/delete events. It does NOT use real fs.watch — that responsibility
 * belongs to the caller or integration layer. Events are deduplicated so that
 * rapid changes to the same file result in a single reindex operation.
 */
export class DocumentWatchService {
  private readonly indexer: DocumentIndexer;
  private readonly registry: DocumentSourceRegistry;
  private readonly config: WatchServiceConfig;
  private readonly watchedSources = new Set<string>();
  private readonly queue = new Map<string, FileChangeEvent>();
  private readonly fileSystem?: WatchServiceFileSystem;

  constructor(dependencies: {
    indexer: DocumentIndexer;
    registry: DocumentSourceRegistry;
    config?: Partial<WatchServiceConfig>;
    fileSystem?: WatchServiceFileSystem;
  }) {
    this.indexer = dependencies.indexer;
    this.registry = dependencies.registry;
    this.config = { ...DEFAULT_WATCH_CONFIG, ...dependencies.config };
    this.fileSystem = dependencies.fileSystem;
  }

  watchSource(sourceId: string): Result<void, MemoryError> {
    const sourceResult = this.registry.get(sourceId);
    if (!sourceResult.ok) {
      return err(new MemoryError(sourceResult.error.message, "MEMORY_DB_ERROR", sourceResult.error));
    }

    const source = sourceResult.value;
    if (!source) {
      return err(new MemoryError(`Source not found: ${sourceId}`, "MEMORY_NOT_READY"));
    }

    if (source.status === "removed") {
      return err(new MemoryError(`Cannot watch removed source: ${sourceId}`, "MEMORY_NOT_READY"));
    }

    this.watchedSources.add(sourceId);
    return ok(undefined);
  }

  unwatchSource(sourceId: string): Result<void, MemoryError> {
    if (!this.watchedSources.has(sourceId)) {
      return err(new MemoryError(`Source not watched: ${sourceId}`, "MEMORY_NOT_READY"));
    }

    this.watchedSources.delete(sourceId);

    // Remove queued events for this source
    for (const [key, event] of this.queue.entries()) {
      if (event.sourceId === sourceId) {
        this.queue.delete(key);
      }
    }

    return ok(undefined);
  }

  handleFileChange(event: FileChangeEvent): Result<void, MemoryError> {
    if (!this.watchedSources.has(event.sourceId)) {
      return err(
        new MemoryError(
          `Source not watched: ${event.sourceId}`,
          "MEMORY_NOT_READY",
        ),
      );
    }

    if (this.queue.size >= this.config.maxQueueSize && !this.queue.has(event.filePath)) {
      return err(
        new MemoryError(
          `Queue full: max ${this.config.maxQueueSize} events`,
          "MEMORY_DB_ERROR",
        ),
      );
    }

    // Deduplication: latest event for a given filePath wins
    this.queue.set(event.filePath, event);
    return ok(undefined);
  }

  async processQueue(): Promise<Result<ProcessResult, MemoryError>> {
    if (this.queue.size === 0) {
      return ok({ processed: 0, errors: 0 });
    }

    // Snapshot and clear the queue so new events can arrive during processing
    const events = Array.from(this.queue.values());
    this.queue.clear();

    let processed = 0;
    let errors = 0;

    for (const event of events) {
      // Skip events for sources that were unwatched during processing
      if (!this.watchedSources.has(event.sourceId)) {
        continue;
      }

      // Check policy before processing (deletes always pass)
      if (!this.matchesSourcePolicy(event)) {
        continue;
      }

      const result = await this.processEvent(event);
      if (result.ok) {
        processed++;
      } else {
        errors++;
      }
    }

    return ok({ processed, errors });
  }

  getQueueSize(): number {
    return this.queue.size;
  }

  getWatchedSources(): string[] {
    return Array.from(this.watchedSources);
  }

  async recoverFromRestart(sourceId: string): Promise<Result<void, MemoryError>> {
    if (!this.fileSystem) {
      return err(
        new MemoryError(
          "FileSystem not provided for restart recovery",
          "MEMORY_NOT_READY",
        ),
      );
    }

    const sourceResult = this.registry.get(sourceId);
    if (!sourceResult.ok) {
      return err(new MemoryError(sourceResult.error.message, "MEMORY_DB_ERROR", sourceResult.error));
    }

    const source = sourceResult.value;
    if (!source) {
      return err(new MemoryError(`Source not found: ${sourceId}`, "MEMORY_NOT_READY"));
    }

    if (source.status === "removed") {
      return err(new MemoryError(`Cannot recover removed source: ${sourceId}`, "MEMORY_NOT_READY"));
    }

    // Ensure source is watched
    if (!this.watchedSources.has(sourceId)) {
      this.watchedSources.add(sourceId);
    }

    // Get current filesystem state
    const fsResult = await this.fileSystem.listFiles(source.rootPath, source.policy.maxDepth);
    if (!fsResult.ok) {
      return err(fsResult.error);
    }

    const currentFiles = fsResult.value;
    const currentFilePaths = new Set(currentFiles.map((f) => f.path));

    // Get currently indexed file paths from chunks
    const indexedChunks = this.indexer.getChunksBySource(sourceId);
    const indexedFilePaths = new Set<string>();
    for (const chunk of indexedChunks) {
      indexedFilePaths.add(chunk.sourcePath);
    }

    const now = new Date().toISOString();

    // Queue events based on filesystem vs index comparison
    for (const file of currentFiles) {
      const relativePath = normalizeForPolicy(source.rootPath, file.path);
      if (!matchesPolicy(relativePath, source.policy)) {
        continue;
      }

      if (!indexedFilePaths.has(file.path)) {
        // New file: on disk but not in index
        this.queue.set(file.path, {
          type: "add",
          filePath: file.path,
          sourceId,
          timestamp: now,
        });
      } else {
        // Existing file: queue update to catch modifications
        this.queue.set(file.path, {
          type: "update",
          filePath: file.path,
          sourceId,
          timestamp: now,
        });
      }
    }

    // Queue delete events for indexed files no longer on disk
    for (const indexedPath of indexedFilePaths) {
      if (!currentFilePaths.has(indexedPath)) {
        this.queue.set(indexedPath, {
          type: "delete",
          filePath: indexedPath,
          sourceId,
          timestamp: now,
        });
      }
    }

    return ok(undefined);
  }

  private async processEvent(event: FileChangeEvent): Promise<Result<void, MemoryError>> {
    switch (event.type) {
      case "delete":
        return this.processDelete(event);
      case "add":
      case "update":
        return this.processAddOrUpdate(event);
    }
  }

  private async processDelete(event: FileChangeEvent): Promise<Result<void, MemoryError>> {
    // The indexer doesn't expose file-level chunk removal directly.
    // Remove all chunks for the source, then re-index from disk so only
    // files that still exist get re-added.
    const removeResult = await this.indexer.removeSource(event.sourceId);
    if (!removeResult.ok) {
      return err(new MemoryError(
        `Failed to remove source chunks for delete of ${event.filePath}: ${removeResult.error.message}`,
        "MEMORY_DB_ERROR",
        removeResult.error,
      ));
    }

    const reindexResult = await this.indexer.indexSource(event.sourceId);
    if (!reindexResult.ok) {
      return err(new MemoryError(
        `Failed to reindex after delete of ${event.filePath}: ${reindexResult.error.message}`,
        "MEMORY_DB_ERROR",
        reindexResult.error,
      ));
    }

    return ok(undefined);
  }

  private async processAddOrUpdate(event: FileChangeEvent): Promise<Result<void, MemoryError>> {
    // indexFile removes existing chunks for the file path before re-chunking
    // and re-embedding, handling both add and update cases.
    const result = await this.indexer.indexFile(event.filePath, event.sourceId);
    if (!result.ok) {
      return err(new MemoryError(
        `Failed to index file ${event.filePath}: ${result.error.message}`,
        "MEMORY_DB_ERROR",
        result.error,
      ));
    }

    return ok(undefined);
  }

  private matchesSourcePolicy(event: FileChangeEvent): boolean {
    // Delete events always pass — we need to clean up regardless of policy
    if (event.type === "delete") {
      return true;
    }

    const sourceResult = this.registry.get(event.sourceId);
    if (!sourceResult.ok || !sourceResult.value) {
      return false;
    }

    const source = sourceResult.value;

    // Enforce root boundary — reject paths that escape the source root
    const canonicalRoot = resolve(source.rootPath);
    const canonicalPath = resolve(source.rootPath, event.filePath);
    const rel = relative(canonicalRoot, canonicalPath);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return false;
    }

    const relativePath = normalizeForPolicy(source.rootPath, event.filePath);
    return matchesPolicy(relativePath, source.policy);
  }
}

function normalizeForPolicy(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath).replace(/\\/g, "/");
}
