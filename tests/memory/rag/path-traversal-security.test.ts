import { describe, expect, it } from "bun:test";

import type {
  EmbeddingProvider,
  EmbeddingProviderError,
} from "../../../src/memory/embeddings/embedding-provider";
import { MemoryError } from "../../../src/memory/services/memory-error";
import {
  DocumentIndexer,
  type DocumentIndexerFileSystem,
} from "../../../src/memory/rag/document-indexer";
import { DocumentSourceRegistry } from "../../../src/memory/rag/document-source-registry";
import { MarkdownChunker } from "../../../src/memory/rag/markdown-chunker";
import {
  DocumentWatchService,
  type FileChangeEvent,
} from "../../../src/memory/rag/document-watch-service";
import { err, ok, type Result } from "../../../src/result";

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id = "mock";
  readonly model = "mock-model";
  readonly dimension = 4;
  readonly version = "1.0.0";

  async embed(text: string): Promise<Result<Float32Array, EmbeddingProviderError>> {
    const vector = new Float32Array(this.dimension);
    vector.fill(text.length / 10);
    return ok(vector);
  }

  async embedBatch(texts: string[]): Promise<Result<Float32Array[], EmbeddingProviderError>> {
    const vectors = texts.map((text) => {
      const vector = new Float32Array(this.dimension);
      vector.fill(text.length / 10);
      return vector;
    });
    return ok(vectors);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class MockFileSystem implements DocumentIndexerFileSystem {
  private readonly files: Map<string, string>;
  private readonly resolvedPaths: Map<string, string>;

  constructor(files: Record<string, string>, resolvedPaths?: Record<string, string>) {
    this.files = new Map(Object.entries(files));
    this.resolvedPaths = new Map(Object.entries(resolvedPaths ?? {}));
  }

  async scanDirectory(): Promise<Result<Array<{ path: string; size: number }>, MemoryError>> {
    const entries = Array.from(this.files.entries()).map(([path, content]) => ({
      path,
      size: Buffer.byteLength(content, "utf8"),
    }));
    return ok(entries);
  }

  async readFile(filePath: string): Promise<Result<string, MemoryError>> {
    const content = this.files.get(filePath);
    if (content === undefined) {
      return err(new MemoryError("File not found", "MEMORY_DB_ERROR"));
    }
    return ok(content);
  }

  async resolvePath(filePath: string): Promise<Result<string, MemoryError>> {
    return ok(this.resolvedPaths.get(filePath) ?? filePath);
  }
}

function makeEvent(type: FileChangeEvent["type"], filePath: string, sourceId: string): FileChangeEvent {
  return {
    type,
    filePath,
    sourceId,
    timestamp: new Date().toISOString(),
  };
}

describe("RAG path traversal security", () => {
  it("rejects traversal and absolute paths in indexer", async () => {
    const registry = new DocumentSourceRegistry();
    const register = registry.register("/docs");
    expect(register.ok).toBe(true);
    if (!register.ok) {
      throw register.error;
    }

    const indexer = new DocumentIndexer({
      chunker: new MarkdownChunker({ strategy: "fixed", maxChunkSize: 40, overlapSize: 0 }),
      embeddingProvider: new MockEmbeddingProvider(),
      registry,
      fileSystem: new MockFileSystem({
        "/docs/readme.md": "safe",
      }),
    });

    const traversal = await indexer.indexFile("../secret.md", register.value.id);
    expect(traversal.ok).toBe(false);

    const absolute = await indexer.indexFile("/etc/passwd", register.value.id);
    expect(absolute.ok).toBe(false);

    if (!absolute.ok) {
      expect(absolute.error.message.includes("/etc/passwd")).toBe(false);
    }
  });

  it("rejects paths with embedded traversal segments", async () => {
    const registry = new DocumentSourceRegistry();
    const register = registry.register("/docs");
    expect(register.ok).toBe(true);
    if (!register.ok) {
      throw register.error;
    }

    const indexer = new DocumentIndexer({
      chunker: new MarkdownChunker({ strategy: "fixed", maxChunkSize: 40, overlapSize: 0 }),
      embeddingProvider: new MockEmbeddingProvider(),
      registry,
      fileSystem: new MockFileSystem({
        "/docs/readme.md": "safe content",
      }),
    });

    // Path that uses .. to escape even though it starts inside root
    const embeddedTraversal = await indexer.indexFile("/docs/sub/../../secret.md", register.value.id);
    expect(embeddedTraversal.ok).toBe(false);
    if (!embeddedTraversal.ok) {
      // Error message should not leak the attempted path
      expect(embeddedTraversal.error.message).toBe("Path outside registered source root");
    }
  });

  it("drops watch events that escape source root before indexing", async () => {
    const registry = new DocumentSourceRegistry();
    const register = registry.register("/docs");
    expect(register.ok).toBe(true);
    if (!register.ok) {
      throw register.error;
    }

    const indexer = new DocumentIndexer({
      chunker: new MarkdownChunker({ strategy: "fixed", maxChunkSize: 40, overlapSize: 0 }),
      embeddingProvider: new MockEmbeddingProvider(),
      registry,
      fileSystem: new MockFileSystem({
        "/docs/readme.md": "safe",
      }),
    });

    const watchService = new DocumentWatchService({
      indexer,
      registry,
      config: { maxQueueSize: 10, debounceMs: 1, processIntervalMs: 1 },
    });

    const watch = watchService.watchSource(register.value.id);
    expect(watch.ok).toBe(true);

    const queued = watchService.handleFileChange(
      makeEvent("add", "../secret.md", register.value.id),
    );
    expect(queued.ok).toBe(true);

    const processed = await watchService.processQueue();
    expect(processed.ok).toBe(true);
    if (processed.ok) {
      expect(processed.value.processed).toBe(0);
      expect(processed.value.errors).toBe(0);
    }
  });
});
