import { describe, expect, it } from "bun:test";

import { err, ok, type Result } from "../../../src/result";
import {
  DocumentSemanticSearch,
  HybridDocumentSearch,
  type IndexedChunk,
} from "../../../src/memory/rag/index";
import type { EmbeddingProvider, EmbeddingProviderError } from "../../../src/memory/embeddings/index";
import type { DocumentSearchProvider } from "../../../src/memory/search/index";

function createChunk(options: {
  id: string;
  content: string;
  sourcePath?: string;
  heading?: string | null;
  embedding?: Float32Array;
}): IndexedChunk {
  return {
    id: options.id,
    sourceId: "source-1",
    sourcePath: options.sourcePath ?? "/docs/guide.md",
    heading: options.heading ?? null,
    headingHierarchy: [],
    content: options.content,
    startOffset: 0,
    endOffset: options.content.length,
    chunkIndex: 0,
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

describe("DocumentSemanticSearch", () => {
  it("returns ranked chunks by semantic score descending", () => {
    const search = new DocumentSemanticSearch();
    const query = new Float32Array([1, 0, 0]);

    const chunks: IndexedChunk[] = [
      createChunk({ id: "a", content: "exact", embedding: new Float32Array([1, 0, 0]) }),
      createChunk({ id: "b", content: "close", embedding: new Float32Array([0.8, 0.2, 0]) }),
      createChunk({ id: "c", content: "far", embedding: new Float32Array([0, 1, 0]) }),
    ];

    const result = search.search(query, chunks);

    expect(result).toHaveLength(3);
    expect(result[0]?.chunk.id).toBe("a");
    expect(result[1]?.chunk.id).toBe("b");
    expect(result[2]?.chunk.id).toBe("c");
    expect(result[0]?.semanticScore ?? 0).toBeGreaterThan(result[1]?.semanticScore ?? 0);
    expect(result[1]?.semanticScore ?? 0).toBeGreaterThanOrEqual(result[2]?.semanticScore ?? 0);
    expect(result[0]?.keywordScore).toBe(0);
    expect(result[0]?.score).toBe(result[0]?.semanticScore);
  });

  it("returns empty result for an empty corpus", () => {
    const search = new DocumentSemanticSearch();
    const query = new Float32Array([1, 0, 0]);

    expect(search.search(query, [])).toEqual([]);
  });

  it("skips chunks without embeddings gracefully", () => {
    const search = new DocumentSemanticSearch();
    const query = new Float32Array([1, 0, 0]);

    const missingEmbedding = {
      ...createChunk({ id: "no-embedding", content: "missing" }),
      embedding: undefined,
    } as unknown as IndexedChunk;

    const valid = createChunk({
      id: "valid",
      content: "valid embedding",
      embedding: new Float32Array([1, 0, 0]),
    });

    const result = search.search(query, [missingEmbedding, valid]);

    expect(result).toHaveLength(1);
    expect(result[0]?.chunk.id).toBe("valid");
  });

  it("applies sourceFilter, minScore, and topK", () => {
    const search = new DocumentSemanticSearch();
    const query = new Float32Array([1, 0, 0]);

    const chunks: IndexedChunk[] = [
      createChunk({
        id: "allowed-1",
        content: "allowed one",
        sourcePath: "/docs/engineering/guide.md",
        heading: "Guide",
        embedding: new Float32Array([1, 0, 0]),
      }),
      createChunk({
        id: "allowed-2",
        content: "allowed two",
        sourcePath: "/docs/engineering/api.md",
        heading: null,
        embedding: new Float32Array([0.95, 0.05, 0]),
      }),
      createChunk({
        id: "filtered-out",
        content: "other source",
        sourcePath: "/docs/design/notes.md",
        embedding: new Float32Array([1, 0, 0]),
      }),
      createChunk({
        id: "below-threshold",
        content: "weak match",
        sourcePath: "/docs/engineering/weak.md",
        embedding: new Float32Array([0.2, 0.98, 0]),
      }),
    ];

    const result = search.search(query, chunks, {
      sourceFilter: "/docs/engineering",
      minScore: 0.9,
      topK: 1,
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.chunk.id).toBe("allowed-1");
    expect(result[0]?.source.path).toBe("/docs/engineering/guide.md");
    expect(result[0]?.source.heading).toBe("Guide");
  });
});

function createEmbeddingProvider(
  embed: (text: string) => Promise<Result<Float32Array, EmbeddingProviderError>>,
): EmbeddingProvider {
  return {
    id: "test-embedding-provider",
    model: "test-model",
    dimension: 3,
    version: "1",
    embed,
    async embedBatch(texts: string[]) {
      const embeddings: Float32Array[] = [];
      for (const text of texts) {
        const result = await embed(text);
        if (!result.ok) {
          return result;
        }

        embeddings.push(result.value);
      }

      return ok(embeddings);
    },
    async isAvailable() {
      return true;
    },
  };
}

describe("HybridDocumentSearch", () => {
  it("blends semantic and keyword scores with 70/30 weighting", async () => {
    const embeddingProvider = createEmbeddingProvider(async () => ok(new Float32Array([1, 0, 0])));
    const search = new HybridDocumentSearch({ embeddingProvider });

    const chunks: IndexedChunk[] = [
      createChunk({
        id: "semantic-first",
        content: "completely unrelated text",
        embedding: new Float32Array([1, 0, 0]),
      }),
      createChunk({
        id: "keyword-first",
        content: "alpha alpha alpha",
        embedding: new Float32Array([0, 1, 0]),
      }),
    ];

    const result = await search.search("alpha", chunks, { topK: 2 });

    expect(result).toHaveLength(2);
    expect(result[0]?.chunk.id).toBe("semantic-first");
    expect(result[0]?.score).toBeCloseTo(0.7, 5);
    expect(result[0]?.semanticScore).toBeCloseTo(1, 5);
    expect(result[0]?.keywordScore).toBe(0);
    expect(result[1]?.score).toBeCloseTo(0.3, 5);
    expect(result[1]?.semanticScore).toBe(0);
    expect(result[1]?.keywordScore).toBe(1);
  });

  it("falls back to keyword-only scoring when embedding fails", async () => {
    const embeddingProvider = createEmbeddingProvider(async () => err(new Error("embedding offline")));
    const search = new HybridDocumentSearch({ embeddingProvider });

    const chunks: IndexedChunk[] = [
      createChunk({
        id: "many-matches",
        content: "alpha alpha alpha",
        embedding: new Float32Array([1, 0, 0]),
      }),
      createChunk({
        id: "few-matches",
        content: "alpha",
        embedding: new Float32Array([1, 0, 0]),
      }),
    ];

    const result = await search.search("alpha", chunks, { topK: 2 });

    expect(result).toHaveLength(2);
    expect(result[0]?.chunk.id).toBe("many-matches");
    expect(result[0]?.semanticScore).toBe(0);
    expect(result[0]?.score).toBe(result[0]?.keywordScore);
    expect(result[0]?.score).toBe(1);
    expect(result[1]?.score).toBeCloseTo(1 / 3, 5);
  });

  it("returns empty results for an empty corpus", async () => {
    const embeddingProvider = createEmbeddingProvider(async () => ok(new Float32Array([1, 0, 0])));
    const search = new HybridDocumentSearch({ embeddingProvider });

    const result = await search.search("anything", []);
    expect(result).toEqual([]);
  });

  it("implements DocumentSearchProvider for unified retrieval", async () => {
    const embeddingProvider = createEmbeddingProvider(async () => ok(new Float32Array([1, 0, 0])));
    const chunks: IndexedChunk[] = [
      createChunk({
        id: "source-1-match",
        content: "alpha in source one",
        sourcePath: "/docs/source-1.md",
        embedding: new Float32Array([1, 0, 0]),
      }),
      createChunk({
        id: "source-2-match",
        content: "alpha in source two",
        sourcePath: "/docs/source-2.md",
        embedding: new Float32Array([1, 0, 0]),
      }),
    ];

    chunks[0].sourceId = "source-1";
    chunks[1].sourceId = "source-2";

    const provider: DocumentSearchProvider = new HybridDocumentSearch({
      embeddingProvider,
      getChunks: async () => chunks,
    });

    const result = await provider.search("alpha", 5, { sourceIds: ["source-1"] });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.chunkId).toBe("source-1-match");
    expect(result.value[0]?.sourceId).toBe("source-1");
  });
});
