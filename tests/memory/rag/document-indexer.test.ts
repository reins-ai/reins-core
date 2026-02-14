import { describe, expect, it } from "bun:test";

import type {
  EmbeddingProvider,
  EmbeddingProviderError,
} from "../../../src/memory/embeddings/embedding-provider";
import { err, ok, type Result } from "../../../src/result";
import {
  DocumentIndexer,
  type DocumentIndexerFileSystem,
  type IndexedChunk,
} from "../../../src/memory/rag/document-indexer";
import { DocumentSourceRegistry } from "../../../src/memory/rag/document-source-registry";
import { MarkdownChunker } from "../../../src/memory/rag/markdown-chunker";
import { EmbeddingProviderError as ProviderError } from "../../../src/memory/embeddings/embedding-provider";
import { MemoryError } from "../../../src/memory/services/memory-error";

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimension: number;
  readonly version: string;
  readonly batchCalls: number[] = [];
  private readonly failOnText: string | null;

  constructor(options?: { id?: string; model?: string; dimension?: number; version?: string; failOnText?: string }) {
    this.id = options?.id ?? "mock-provider";
    this.model = options?.model ?? "mock-model";
    this.dimension = options?.dimension ?? 4;
    this.version = options?.version ?? "1.0.0";
    this.failOnText = options?.failOnText ?? null;
  }

  async embed(text: string): Promise<Result<Float32Array, EmbeddingProviderError>> {
    if (this.failOnText && text.includes(this.failOnText)) {
      return err(new ProviderError("embed failed", "EMBEDDING_PROVIDER_REQUEST_FAILED"));
    }

    return ok(this.makeVector(text));
  }

  async embedBatch(texts: string[]): Promise<Result<Float32Array[], EmbeddingProviderError>> {
    this.batchCalls.push(texts.length);

    if (this.failOnText && texts.some((text) => text.includes(this.failOnText))) {
      return err(new ProviderError("embedBatch failed", "EMBEDDING_PROVIDER_REQUEST_FAILED"));
    }

    return ok(texts.map((text) => this.makeVector(text)));
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private makeVector(text: string): Float32Array {
    const size = this.dimension;
    const vector = new Float32Array(size);
    for (let i = 0; i < size; i++) {
      vector[i] = (text.length + i) / 10;
    }
    return vector;
  }
}

class MockFileSystem implements DocumentIndexerFileSystem {
  private readonly files: Map<string, string>;
  private readonly scanFiles: Array<{ path: string; size: number }>;
  private readonly readFailures: Set<string>;

  constructor(options: {
    files?: Record<string, string>;
    scanFiles?: Array<{ path: string; size: number }>;
    readFailures?: string[];
  }) {
    this.files = new Map<string, string>();
    for (const [path, content] of Object.entries(options.files ?? {})) {
      this.files.set(path, content);
    }

    this.scanFiles = options.scanFiles ?? Array.from(this.files.entries()).map(([path, content]) => ({
      path,
      size: Buffer.byteLength(content, "utf8"),
    }));

    this.readFailures = new Set(options.readFailures ?? []);
  }

  async scanDirectory(
    _rootPath: string,
    _maxDepth: number,
  ): Promise<Result<Array<{ path: string; size: number }>, MemoryError>> {
    return ok(this.scanFiles);
  }

  async readFile(filePath: string): Promise<Result<string, MemoryError>> {
    if (this.readFailures.has(filePath)) {
      return err(new MemoryError(`Failed to read file: ${filePath}`, "MEMORY_DB_ERROR"));
    }

    const content = this.files.get(filePath);
    if (content === undefined) {
      return err(new MemoryError(`File not found: ${filePath}`, "MEMORY_DB_ERROR"));
    }

    return ok(content);
  }
}

function registerSource(
  registry: DocumentSourceRegistry,
  rootPath = "/docs",
  policy?: {
    includePaths?: string[];
    excludePaths?: string[];
    maxFileSize?: number;
  },
): string {
  const result = registry.register(rootPath, {
    policy,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw result.error;
  }

  return result.value.id;
}

function createIndexer(options: {
  fileSystem: MockFileSystem;
  embeddingProvider?: MockEmbeddingProvider;
  onJobUpdate?: (status: string) => void;
  batchSize?: number;
}): { indexer: DocumentIndexer; registry: DocumentSourceRegistry; provider: MockEmbeddingProvider } {
  const registry = new DocumentSourceRegistry();
  const provider = options.embeddingProvider ?? new MockEmbeddingProvider();

  const indexer = new DocumentIndexer({
    chunker: new MarkdownChunker({ strategy: "fixed", maxChunkSize: 20, overlapSize: 0 }),
    embeddingProvider: provider,
    registry,
    config: {
      batchSize: options.batchSize ?? 2,
      maxConcurrent: 3,
      retryAttempts: 0,
      retryDelayMs: 1,
    },
    fileSystem: options.fileSystem,
    onJobUpdate: (job) => {
      options.onJobUpdate?.(job.status);
    },
  });

  return { indexer, registry, provider };
}

function getSourceChunks(indexer: DocumentIndexer, sourceId: string): IndexedChunk[] {
  return indexer.getChunksBySource(sourceId);
}

describe("DocumentIndexer", () => {
  it("indexes a markdown directory and stores retrievable chunks", async () => {
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/a.md": "# A\n\nAlpha content here.",
        "/docs/b.md": "# B\n\nBeta content here.",
      },
    });

    const { indexer, registry } = createIndexer({ fileSystem });
    const sourceId = registerSource(registry);

    const result = await indexer.indexSource(sourceId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }

    const chunks = getSourceChunks(indexer, sourceId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(indexer.searchByContent("alpha").length).toBeGreaterThan(0);
  });

  it("integrates chunking and embeddings", async () => {
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/single.md": "# Intro\n\nThis file should produce chunks and embeddings.",
      },
    });

    const { indexer, registry, provider } = createIndexer({ fileSystem, batchSize: 1 });
    const sourceId = registerSource(registry);

    const result = await indexer.indexSource(sourceId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }

    const chunks = getSourceChunks(indexer, sourceId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(provider.batchCalls.length).toBeGreaterThan(0);
    expect(chunks[0].embedding.length).toBe(provider.dimension);
  });

  it("processes embeddings in configured batch sizes", async () => {
    const content = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(4);
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/long.md": content,
      },
    });

    const provider = new MockEmbeddingProvider();
    const { indexer, registry } = createIndexer({ fileSystem, embeddingProvider: provider, batchSize: 2 });
    const sourceId = registerSource(registry);

    const result = await indexer.indexSource(sourceId);
    expect(result.ok).toBe(true);

    expect(provider.batchCalls.every((callSize) => callSize <= 2)).toBe(true);
    expect(provider.batchCalls.length).toBeGreaterThan(1);
  });

  it("tracks job status transitions from pending to running to complete", async () => {
    const statuses: string[] = [];
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/status.md": "status tracking content",
      },
    });

    const { indexer, registry } = createIndexer({
      fileSystem,
      onJobUpdate: (status) => {
        statuses.push(status);
      },
    });
    const sourceId = registerSource(registry);

    const result = await indexer.indexSource(sourceId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }

    expect(statuses[0]).toBe("pending");
    expect(statuses).toContain("running");
    expect(statuses[statuses.length - 1]).toBe("complete");
  });

  it("collects per-file errors and still completes job", async () => {
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/good.md": "good content",
        "/docs/bad.md": "bad content",
      },
      readFailures: ["/docs/bad.md"],
    });

    const { indexer, registry } = createIndexer({ fileSystem });
    const sourceId = registerSource(registry);

    const result = await indexer.indexSource(sourceId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }

    expect(result.value.status).toBe("complete");
    expect(result.value.errors.length).toBe(1);
    expect(indexer.searchByContent("good").length).toBeGreaterThan(0);
  });

  it("handles embedding failures as per-file errors", async () => {
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/fail.md": "this will fail embedding",
      },
    });

    const provider = new MockEmbeddingProvider({ failOnText: "fail" });
    const { indexer, registry } = createIndexer({ fileSystem, embeddingProvider: provider });
    const sourceId = registerSource(registry);

    const result = await indexer.indexSource(sourceId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }

    expect(result.value.errors.length).toBe(1);
    expect(getSourceChunks(indexer, sourceId)).toHaveLength(0);
  });

  it("removes all indexed chunks for a source", async () => {
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/rm.md": "remove source content",
      },
    });

    const { indexer, registry } = createIndexer({ fileSystem });
    const sourceId = registerSource(registry);

    const indexResult = await indexer.indexSource(sourceId);
    expect(indexResult.ok).toBe(true);
    expect(getSourceChunks(indexer, sourceId).length).toBeGreaterThan(0);

    const removeResult = await indexer.removeSource(sourceId);
    expect(removeResult.ok).toBe(true);
    expect(getSourceChunks(indexer, sourceId)).toHaveLength(0);
  });

  it("tags indexed chunks with embedding provider metadata", async () => {
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/meta.md": "provider metadata test",
      },
    });

    const provider = new MockEmbeddingProvider({
      id: "openai",
      model: "text-embedding-3-small",
      dimension: 8,
      version: "2026-02",
    });
    const { indexer, registry } = createIndexer({ fileSystem, embeddingProvider: provider });
    const sourceId = registerSource(registry);

    const result = await indexer.indexSource(sourceId);
    expect(result.ok).toBe(true);

    const chunks = getSourceChunks(indexer, sourceId);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].embeddingMetadata.provider).toBe("openai");
    expect(chunks[0].embeddingMetadata.model).toBe("text-embedding-3-small");
    expect(chunks[0].embeddingMetadata.dimensions).toBe(8);
    expect(chunks[0].embeddingMetadata.indexVersion).toBe("v1");
  });

  it("applies source policy filtering before indexing", async () => {
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/readme.md": "include this",
        "/docs/notes.txt": "exclude by include rule",
        "/docs/drafts/wip.md": "exclude by exclude rule",
      },
    });

    const { indexer, registry } = createIndexer({ fileSystem });
    const sourceId = registerSource(registry, "/docs", {
      includePaths: ["**/*.md"],
      excludePaths: ["drafts/**/*.md"],
    });

    const result = await indexer.indexSource(sourceId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }

    const indexedContents = getSourceChunks(indexer, sourceId).map((chunk) => chunk.content).join(" ");
    expect(indexedContents.includes("include this")).toBe(true);
    expect(indexedContents.includes("exclude by include rule")).toBe(false);
    expect(indexedContents.includes("exclude by exclude rule")).toBe(false);
  });

  it("indexes a single file directly", async () => {
    const fileSystem = new MockFileSystem({
      files: {
        "/docs/direct.md": "single file indexing works",
      },
    });

    const { indexer } = createIndexer({ fileSystem });
    const result = await indexer.indexFile("/docs/direct.md", "source-1");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }

    expect(result.value.length).toBeGreaterThan(0);
    expect(indexer.getChunksBySource("source-1").length).toBeGreaterThan(0);
  });

  it("handles an empty directory", async () => {
    const fileSystem = new MockFileSystem({ files: {}, scanFiles: [] });
    const { indexer, registry } = createIndexer({ fileSystem });
    const sourceId = registerSource(registry);

    const result = await indexer.indexSource(sourceId);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw result.error;
    }

    expect(result.value.chunksProcessed).toBe(0);
    expect(result.value.chunksTotal).toBe(0);
    expect(result.value.embeddingsGenerated).toBe(0);
    expect(getSourceChunks(indexer, sourceId)).toHaveLength(0);
  });
});
