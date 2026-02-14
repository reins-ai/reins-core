import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { EmbeddingProvider } from "../embeddings/embedding-provider";
import { MemoryError } from "../services/memory-error";
import { err, ok, type Result } from "../../result";
import type { DocumentChunk, MarkdownChunker } from "./markdown-chunker";
import type { DocumentSource } from "./document-source-registry";
import { DocumentSourceRegistry } from "./document-source-registry";
import { matchesPolicy } from "./document-source-policy";
import {
  DEFAULT_BATCH_CONFIG,
  type IndexBatchConfig,
  type IndexJob,
  type IndexJobStatus,
} from "./document-index-jobs";

const INDEX_VERSION = "v1";

export interface IndexedChunk {
  id: string;
  sourceId: string;
  sourcePath: string;
  heading: string | null;
  headingHierarchy: string[];
  content: string;
  startOffset: number;
  endOffset: number;
  chunkIndex: number;
  totalChunks: number;
  metadata: DocumentChunk["metadata"];
  embedding: Float32Array;
  ftsIndexed: boolean;
  embeddingMetadata: {
    provider: string;
    model: string;
    dimensions: number;
    version: string;
    indexedAt: string;
    indexVersion: string;
  };
}

interface FileSystemEntry {
  path: string;
  size: number;
}

export interface DocumentIndexerFileSystem {
  scanDirectory(rootPath: string, maxDepth: number): Promise<Result<FileSystemEntry[], MemoryError>>;
  readFile(filePath: string): Promise<Result<string, MemoryError>>;
}

export interface DocumentIndexerDependencies {
  chunker: MarkdownChunker;
  embeddingProvider: EmbeddingProvider;
  registry: DocumentSourceRegistry;
  config?: Partial<IndexBatchConfig>;
  fileSystem?: DocumentIndexerFileSystem;
  onJobUpdate?: (job: IndexJob) => void;
}

class NodeDocumentIndexerFileSystem implements DocumentIndexerFileSystem {
  async scanDirectory(rootPath: string, maxDepth: number): Promise<Result<FileSystemEntry[], MemoryError>> {
    try {
      const files: FileSystemEntry[] = [];
      await this.walk(rootPath, maxDepth, 0, files);
      return ok(files);
    } catch (error) {
      return err(
        new MemoryError(
          `Failed to scan source directory: ${rootPath}`,
          "MEMORY_DB_ERROR",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  async readFile(filePath: string): Promise<Result<string, MemoryError>> {
    try {
      const content = await readFile(filePath, "utf8");
      return ok(content);
    } catch (error) {
      return err(
        new MemoryError(
          `Failed to read file: ${filePath}`,
          "MEMORY_DB_ERROR",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  private async walk(
    currentPath: string,
    maxDepth: number,
    depth: number,
    files: FileSystemEntry[],
  ): Promise<void> {
    if (depth > maxDepth) {
      return;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(currentPath, entry.name);
      if (entry.isDirectory()) {
        await this.walk(fullPath, maxDepth, depth + 1, files);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const fileStats = await stat(fullPath);
      files.push({ path: fullPath, size: fileStats.size });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalizeForPolicy(rootPath: string, filePath: string): string {
  return relative(rootPath, filePath).replace(/\\/g, "/");
}

export class DocumentIndexer {
  private readonly chunker: MarkdownChunker;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly registry: DocumentSourceRegistry;
  private readonly config: IndexBatchConfig;
  private readonly fileSystem: DocumentIndexerFileSystem;
  private readonly onJobUpdate?: (job: IndexJob) => void;
  private readonly chunks = new Map<string, IndexedChunk>();

  constructor(dependencies: DocumentIndexerDependencies) {
    this.chunker = dependencies.chunker;
    this.embeddingProvider = dependencies.embeddingProvider;
    this.registry = dependencies.registry;
    this.config = { ...DEFAULT_BATCH_CONFIG, ...dependencies.config };
    this.fileSystem = dependencies.fileSystem ?? new NodeDocumentIndexerFileSystem();
    this.onJobUpdate = dependencies.onJobUpdate;
  }

  async indexSource(sourceId: string): Promise<Result<IndexJob, MemoryError>> {
    const sourceResult = this.registry.get(sourceId);
    if (!sourceResult.ok) {
      return err(new MemoryError(sourceResult.error.message, "MEMORY_DB_ERROR", sourceResult.error));
    }

    const source = sourceResult.value;
    if (!source) {
      return err(new MemoryError(`Source not found: ${sourceId}`, "MEMORY_NOT_READY"));
    }

    if (source.status === "removed") {
      return err(new MemoryError(`Cannot index removed source: ${sourceId}`, "MEMORY_NOT_READY"));
    }

    const startedAt = new Date().toISOString();
    const baseJob: IndexJob = {
      id: randomUUID(),
      sourceId,
      status: "pending",
      startedAt,
      chunksProcessed: 0,
      chunksTotal: 0,
      embeddingsGenerated: 0,
      errors: [],
      embeddingProvider: this.embeddingProvider.id,
      embeddingModel: this.embeddingProvider.model,
      embeddingDimensions: this.embeddingProvider.dimension,
    };

    this.publishJob(baseJob);

    const statusResult = this.registry.updateStatus(sourceId, "indexing");
    if (!statusResult.ok) {
      return err(new MemoryError(statusResult.error.message, "MEMORY_DB_ERROR", statusResult.error));
    }

    let job = this.withStatus(baseJob, "running");
    this.publishJob(job);

    const scanResult = await this.fileSystem.scanDirectory(source.rootPath, source.policy.maxDepth);
    if (!scanResult.ok) {
      await this.setSourceError(sourceId, scanResult.error.message);
      job = this.completeFailedJob(job, scanResult.error.message);
      this.publishJob(job);
      return err(scanResult.error);
    }

    const filesToIndex = this.filterFiles(scanResult.value, source);
    const fileErrors: string[] = [];

    await this.runWithConcurrency(filesToIndex, this.config.maxConcurrent, async (entry) => {
      const fileResult = await this.indexFile(entry.path, sourceId);
      if (!fileResult.ok) {
        fileErrors.push(fileResult.error.message);
        return;
      }

      job = {
        ...job,
        chunksProcessed: job.chunksProcessed + fileResult.value.length,
        chunksTotal: job.chunksTotal + fileResult.value.length,
        embeddingsGenerated: job.embeddingsGenerated + fileResult.value.length,
      };
      this.publishJob(job);
    });

    const checkpoint = `${Date.now()}:${job.chunksProcessed}`;
    const indexedAt = new Date().toISOString();
    const indexedResult = this.registry.updateStatus(sourceId, "indexed", {
      lastIndexedAt: indexedAt,
      fileCount: filesToIndex.length,
      lastCheckpoint: checkpoint,
      errorMessage: fileErrors.length > 0 ? fileErrors.join(" | ") : undefined,
    });

    if (!indexedResult.ok) {
      await this.setSourceError(sourceId, indexedResult.error.message);
      job = this.completeFailedJob(job, indexedResult.error.message);
      this.publishJob(job);
      return err(new MemoryError(indexedResult.error.message, "MEMORY_DB_ERROR", indexedResult.error));
    }

    job = {
      ...job,
      status: "complete",
      completedAt: new Date().toISOString(),
      errors: fileErrors,
    };
    this.publishJob(job);
    return ok(job);
  }

  async indexFile(filePath: string, sourceId: string): Promise<Result<DocumentChunk[], MemoryError>> {
    // Defense-in-depth: enforce that filePath is contained within its source root
    const sourceResult = this.registry.get(sourceId);
    if (sourceResult.ok && sourceResult.value) {
      const sourceRoot = resolve(sourceResult.value.rootPath);
      const canonicalPath = resolve(sourceRoot, filePath);
      const rel = relative(sourceRoot, canonicalPath);
      if (rel.startsWith("..") || isAbsolute(rel)) {
        return err(
          new MemoryError(
            "Path outside registered source root",
            "MEMORY_DB_ERROR",
          ),
        );
      }
    }

    const contentResult = await this.retry(async () => this.fileSystem.readFile(filePath));
    if (!contentResult.ok) {
      return err(contentResult.error);
    }

    const chunkResult = this.chunker.chunk(contentResult.value, filePath, sourceId);
    if (!chunkResult.ok) {
      return err(new MemoryError(chunkResult.error.message, "MEMORY_DB_ERROR", chunkResult.error));
    }

    const chunks = chunkResult.value;
    if (chunks.length === 0) {
      return ok([]);
    }

    this.removeFileChunks(sourceId, filePath);

    for (let index = 0; index < chunks.length; index += this.config.batchSize) {
      const chunkBatch = chunks.slice(index, index + this.config.batchSize);
      const texts = chunkBatch.map((chunk) => chunk.content);
      const embeddingResult = await this.retry(async () => this.embeddingProvider.embedBatch(texts));

      if (!embeddingResult.ok) {
        return err(new MemoryError(embeddingResult.error.message, "MEMORY_DB_ERROR", embeddingResult.error));
      }

      if (embeddingResult.value.length !== chunkBatch.length) {
        return err(
          new MemoryError(
            `Embedding batch size mismatch for ${filePath}: expected ${chunkBatch.length}, got ${embeddingResult.value.length}`,
            "MEMORY_DB_ERROR",
          ),
        );
      }

      const indexedAt = new Date().toISOString();
      for (let i = 0; i < chunkBatch.length; i++) {
        const chunk = chunkBatch[i];
        const embedding = embeddingResult.value[i];

        const indexedChunk: IndexedChunk = {
          ...chunk,
          embedding,
          ftsIndexed: true,
          embeddingMetadata: {
            provider: this.embeddingProvider.id,
            model: this.embeddingProvider.model,
            dimensions: this.embeddingProvider.dimension,
            version: this.embeddingProvider.version,
            indexedAt,
            indexVersion: INDEX_VERSION,
          },
        };

        this.chunks.set(chunk.id, indexedChunk);
      }
    }

    return ok(chunks);
  }

  async removeSource(sourceId: string): Promise<Result<void, MemoryError>> {
    for (const [chunkId, chunk] of this.chunks.entries()) {
      if (chunk.sourceId === sourceId) {
        this.chunks.delete(chunkId);
      }
    }

    return ok(undefined);
  }

  getChunksBySource(sourceId: string): IndexedChunk[] {
    const results: IndexedChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.sourceId === sourceId) {
        results.push(chunk);
      }
    }
    return results;
  }

  getChunk(chunkId: string): IndexedChunk | undefined {
    return this.chunks.get(chunkId);
  }

  searchByContent(query: string): IndexedChunk[] {
    const normalized = query.trim().toLowerCase();
    if (normalized.length === 0) {
      return [];
    }

    const results: IndexedChunk[] = [];
    for (const chunk of this.chunks.values()) {
      if (chunk.content.toLowerCase().includes(normalized)) {
        results.push(chunk);
      }
    }
    return results;
  }

  private removeFileChunks(sourceId: string, sourcePath: string): void {
    for (const [chunkId, chunk] of this.chunks.entries()) {
      if (chunk.sourceId === sourceId && chunk.sourcePath === sourcePath) {
        this.chunks.delete(chunkId);
      }
    }
  }

  private async setSourceError(sourceId: string, message: string): Promise<void> {
    this.registry.updateStatus(sourceId, "error", { errorMessage: message });
  }

  private filterFiles(entries: FileSystemEntry[], source: DocumentSource): FileSystemEntry[] {
    const filtered: FileSystemEntry[] = [];

    for (const entry of entries) {
      const relativePath = normalizeForPolicy(source.rootPath, entry.path);
      if (!matchesPolicy(relativePath, source.policy)) {
        continue;
      }

      if (entry.size > source.policy.maxFileSize) {
        continue;
      }

      filtered.push(entry);
    }

    return filtered;
  }

  private withStatus(job: IndexJob, status: IndexJobStatus): IndexJob {
    const nextJob: IndexJob = { ...job, status };
    this.publishJob(nextJob);
    return nextJob;
  }

  private completeFailedJob(job: IndexJob, message: string): IndexJob {
    return {
      ...job,
      status: "failed",
      completedAt: new Date().toISOString(),
      errors: [...job.errors, message],
    };
  }

  private publishJob(job: IndexJob): void {
    this.onJobUpdate?.(job);
  }

  private async retry<T, E extends Error>(
    operation: () => Promise<Result<T, E>>,
  ): Promise<Result<T, E>> {
    let lastError: E | undefined;
    const attempts = Math.max(1, this.config.retryAttempts + 1);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const result = await operation();
      if (result.ok) {
        return result;
      }

      lastError = result.error;
      if (attempt < attempts - 1) {
        await delay(this.config.retryDelayMs);
      }
    }

    if (!lastError) {
      throw new Error("retry operation failed without error");
    }

    return err(lastError);
  }

  private async runWithConcurrency<T>(
    items: T[],
    maxConcurrent: number,
    worker: (item: T) => Promise<void>,
  ): Promise<void> {
    if (items.length === 0) {
      return;
    }

    const limit = Math.max(1, maxConcurrent);
    let index = 0;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (index < items.length) {
        const current = items[index];
        index += 1;
        await worker(current);
      }
    });

    await Promise.all(runners);
  }
}
