import { describe, expect, it } from "bun:test";

import { ok, err, type Result } from "../../../src/result";
import {
  DocumentSearchAdapter,
  type IndexedChunk,
} from "../../../src/memory/rag/index";
import { DocumentSourceRegistry } from "../../../src/memory/rag/document-source-registry";
import type { HybridDocumentSearch, RankedChunk } from "../../../src/memory/rag/document-semantic-search";
import type { DocumentIndexer } from "../../../src/memory/rag/document-indexer";
import type { DocumentSearchProvider, DocumentSearchResult } from "../../../src/memory/search/unified-memory-retrieval";

function createChunk(options: {
  id: string;
  content: string;
  sourceId: string;
  sourcePath?: string;
  heading?: string | null;
  headingHierarchy?: string[];
  chunkIndex?: number;
  embedding?: Float32Array;
}): IndexedChunk {
  return {
    id: options.id,
    sourceId: options.sourceId,
    sourcePath: options.sourcePath ?? "/docs/guide.md",
    heading: options.heading ?? null,
    headingHierarchy: options.headingHierarchy ?? [],
    content: options.content,
    startOffset: 0,
    endOffset: options.content.length,
    chunkIndex: options.chunkIndex ?? 0,
    totalChunks: 1,
    metadata: {
      tokenCount: options.content.length,
      charCount: options.content.length,
    },
    embedding: options.embedding ?? new Float32Array([1, 0, 0]),
    ftsIndexed: true,
    embeddingMetadata: {
      provider: "test-provider",
      model: "test-model",
      dimensions: 3,
      version: "1",
      indexedAt: new Date(0).toISOString(),
      indexVersion: "v1",
    },
  };
}

function createMockIndexer(chunksBySource: Map<string, IndexedChunk[]>): DocumentIndexer {
  return {
    getChunksBySource(sourceId: string): IndexedChunk[] {
      return chunksBySource.get(sourceId) ?? [];
    },
  } as unknown as DocumentIndexer;
}

function createMockHybridSearch(
  searchFn: (query: string, chunks: IndexedChunk[], options?: { topK?: number }) => Promise<RankedChunk[]>,
): HybridDocumentSearch {
  return {
    search: searchFn,
  } as unknown as HybridDocumentSearch;
}

function rankedFromChunk(chunk: IndexedChunk, score: number): RankedChunk {
  return {
    chunk,
    score,
    semanticScore: score,
    keywordScore: 0,
    source: {
      path: chunk.sourcePath,
      heading: chunk.heading,
    },
  };
}

describe("DocumentSearchAdapter", () => {
  it("implements DocumentSearchProvider interface", () => {
    const registry = new DocumentSourceRegistry();
    const indexer = createMockIndexer(new Map());
    const hybridSearch = createMockHybridSearch(async () => []);

    const adapter: DocumentSearchProvider = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    expect(typeof adapter.search).toBe("function");
  });

  it("returns empty results when no chunks are indexed", async () => {
    const registry = new DocumentSourceRegistry();
    const indexer = createMockIndexer(new Map());
    const hybridSearch = createMockHybridSearch(async () => []);

    const adapter = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    const result = await adapter.search("test query", 5);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("returns ranked results with source metadata from all indexed sources", async () => {
    const registry = new DocumentSourceRegistry();
    registry.register("/docs/project-a", { name: "Project A" });
    const sources = registry.list();
    const sourceId = sources[0].id;
    registry.updateStatus(sourceId, "indexed");

    const chunk = createChunk({
      id: "chunk-1",
      content: "TypeScript best practices",
      sourceId,
      sourcePath: "/docs/project-a/guide.md",
      heading: "Best Practices",
      headingHierarchy: ["Guide", "Best Practices"],
      chunkIndex: 2,
    });

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set(sourceId, [chunk]);

    const indexer = createMockIndexer(chunksBySource);
    const hybridSearch = createMockHybridSearch(async (_query, chunks, _options) => {
      return chunks.map((c) => rankedFromChunk(c, 0.95));
    });

    const adapter = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    const result = await adapter.search("typescript", 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toHaveLength(1);
    const doc = result.value[0];
    expect(doc.chunkId).toBe("chunk-1");
    expect(doc.content).toBe("TypeScript best practices");
    expect(doc.score).toBe(0.95);
    expect(doc.sourcePath).toBe("/docs/project-a/guide.md");
    expect(doc.heading).toBe("Best Practices");
    expect(doc.headingHierarchy).toEqual(["Guide", "Best Practices"]);
    expect(doc.sourceId).toBe(sourceId);
    expect(doc.chunkIndex).toBe(2);
  });

  it("filters chunks by sourceIds when filters are provided", async () => {
    const registry = new DocumentSourceRegistry();
    registry.register("/docs/project-a", { name: "Project A" });
    registry.register("/docs/project-b", { name: "Project B" });
    const sources = registry.list();
    const sourceA = sources[0].id;
    const sourceB = sources[1].id;
    registry.updateStatus(sourceA, "indexed");
    registry.updateStatus(sourceB, "indexed");

    const chunkA = createChunk({
      id: "chunk-a",
      content: "Content from project A",
      sourceId: sourceA,
      sourcePath: "/docs/project-a/readme.md",
    });

    const chunkB = createChunk({
      id: "chunk-b",
      content: "Content from project B",
      sourceId: sourceB,
      sourcePath: "/docs/project-b/readme.md",
    });

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set(sourceA, [chunkA]);
    chunksBySource.set(sourceB, [chunkB]);

    const indexer = createMockIndexer(chunksBySource);

    let receivedChunks: IndexedChunk[] = [];
    const hybridSearch = createMockHybridSearch(async (_query, chunks) => {
      receivedChunks = chunks;
      return chunks.map((c) => rankedFromChunk(c, 0.8));
    });

    const adapter = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    const result = await adapter.search("content", 10, { sourceIds: [sourceA] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0].sourceId).toBe(sourceA);
    expect(result.value).toHaveLength(1);
    expect(result.value[0].chunkId).toBe("chunk-a");
  });

  it("collects chunks from multiple sources when no filter is provided", async () => {
    const registry = new DocumentSourceRegistry();
    registry.register("/docs/alpha", { name: "Alpha" });
    registry.register("/docs/beta", { name: "Beta" });
    const sources = registry.list();
    const alphaId = sources[0].id;
    const betaId = sources[1].id;
    registry.updateStatus(alphaId, "indexed");
    registry.updateStatus(betaId, "indexed");

    const chunkAlpha = createChunk({
      id: "alpha-1",
      content: "Alpha content",
      sourceId: alphaId,
    });

    const chunkBeta = createChunk({
      id: "beta-1",
      content: "Beta content",
      sourceId: betaId,
    });

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set(alphaId, [chunkAlpha]);
    chunksBySource.set(betaId, [chunkBeta]);

    const indexer = createMockIndexer(chunksBySource);

    let receivedChunks: IndexedChunk[] = [];
    const hybridSearch = createMockHybridSearch(async (_query, chunks) => {
      receivedChunks = chunks;
      return chunks.map((c) => rankedFromChunk(c, 0.7));
    });

    const adapter = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    const result = await adapter.search("content", 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(receivedChunks).toHaveLength(2);
    expect(result.value).toHaveLength(2);
  });

  it("only includes chunks from indexed sources (not registered or error)", async () => {
    const registry = new DocumentSourceRegistry();
    registry.register("/docs/indexed-source", { name: "Indexed" });
    registry.register("/docs/registered-source", { name: "Registered" });
    registry.register("/docs/error-source", { name: "Error" });
    const sources = registry.list();
    const indexedId = sources[0].id;
    const registeredId = sources[1].id;
    const errorId = sources[2].id;
    registry.updateStatus(indexedId, "indexed");
    // registeredId stays as "registered"
    registry.updateStatus(errorId, "error");

    const chunkIndexed = createChunk({
      id: "indexed-chunk",
      content: "Indexed content",
      sourceId: indexedId,
    });

    const chunkRegistered = createChunk({
      id: "registered-chunk",
      content: "Registered content",
      sourceId: registeredId,
    });

    const chunkError = createChunk({
      id: "error-chunk",
      content: "Error content",
      sourceId: errorId,
    });

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set(indexedId, [chunkIndexed]);
    chunksBySource.set(registeredId, [chunkRegistered]);
    chunksBySource.set(errorId, [chunkError]);

    const indexer = createMockIndexer(chunksBySource);

    let receivedChunks: IndexedChunk[] = [];
    const hybridSearch = createMockHybridSearch(async (_query, chunks) => {
      receivedChunks = chunks;
      return chunks.map((c) => rankedFromChunk(c, 0.9));
    });

    const adapter = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    const result = await adapter.search("content", 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(receivedChunks).toHaveLength(1);
    expect(receivedChunks[0].id).toBe("indexed-chunk");
    expect(result.value).toHaveLength(1);
  });

  it("passes topK to hybrid search", async () => {
    const registry = new DocumentSourceRegistry();
    registry.register("/docs/source", { name: "Source" });
    const sources = registry.list();
    const sourceId = sources[0].id;
    registry.updateStatus(sourceId, "indexed");

    const chunks = Array.from({ length: 5 }, (_, i) =>
      createChunk({
        id: `chunk-${i}`,
        content: `Content ${i}`,
        sourceId,
        chunkIndex: i,
      }),
    );

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set(sourceId, chunks);

    const indexer = createMockIndexer(chunksBySource);

    let receivedTopK: number | undefined;
    const hybridSearch = createMockHybridSearch(async (_query, inputChunks, options) => {
      receivedTopK = options?.topK;
      return inputChunks.slice(0, options?.topK ?? inputChunks.length).map((c) => rankedFromChunk(c, 0.5));
    });

    const adapter = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    await adapter.search("content", 3);

    expect(receivedTopK).toBe(3);
  });

  it("returns error result when hybrid search throws", async () => {
    const registry = new DocumentSourceRegistry();
    registry.register("/docs/source", { name: "Source" });
    const sources = registry.list();
    const sourceId = sources[0].id;
    registry.updateStatus(sourceId, "indexed");

    const chunk = createChunk({
      id: "chunk-1",
      content: "Some content",
      sourceId,
    });

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set(sourceId, [chunk]);

    const indexer = createMockIndexer(chunksBySource);
    const hybridSearch = createMockHybridSearch(async () => {
      throw new Error("Embedding provider unavailable");
    });

    const adapter = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    const result = await adapter.search("test", 5);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Document search adapter query failed");
    expect(result.error.code).toBe("DOCUMENT_SEARCH_ADAPTER_QUERY_ERROR");
  });

  it("handles empty sourceIds filter by returning all indexed chunks", async () => {
    const registry = new DocumentSourceRegistry();
    registry.register("/docs/source", { name: "Source" });
    const sources = registry.list();
    const sourceId = sources[0].id;
    registry.updateStatus(sourceId, "indexed");

    const chunk = createChunk({
      id: "chunk-1",
      content: "Content",
      sourceId,
    });

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set(sourceId, [chunk]);

    const indexer = createMockIndexer(chunksBySource);
    const hybridSearch = createMockHybridSearch(async (_query, chunks) => {
      return chunks.map((c) => rankedFromChunk(c, 0.8));
    });

    const adapter = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    const result = await adapter.search("content", 10, { sourceIds: [] });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
  });

  it("maps RankedChunk fields to DocumentSearchResult correctly", async () => {
    const registry = new DocumentSourceRegistry();
    registry.register("/docs/source", { name: "Source" });
    const sources = registry.list();
    const sourceId = sources[0].id;
    registry.updateStatus(sourceId, "indexed");

    const chunk = createChunk({
      id: "precise-chunk",
      content: "Precise content for mapping test",
      sourceId,
      sourcePath: "/docs/source/mapping.md",
      heading: "Mapping Section",
      headingHierarchy: ["Root", "Mapping Section"],
      chunkIndex: 7,
    });

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set(sourceId, [chunk]);

    const indexer = createMockIndexer(chunksBySource);
    const hybridSearch = createMockHybridSearch(async (_query, chunks) => {
      return chunks.map((c) => rankedFromChunk(c, 0.92));
    });

    const adapter = new DocumentSearchAdapter({
      hybridSearch,
      indexer,
      registry,
    });

    const result = await adapter.search("mapping", 10);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const doc = result.value[0];
    expect(doc).toEqual({
      chunkId: "precise-chunk",
      content: "Precise content for mapping test",
      score: 0.92,
      sourcePath: "/docs/source/mapping.md",
      heading: "Mapping Section",
      headingHierarchy: ["Root", "Mapping Section"],
      sourceId,
      chunkIndex: 7,
    });
  });
});
