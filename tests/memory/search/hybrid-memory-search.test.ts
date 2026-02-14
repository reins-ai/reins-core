import { describe, expect, test } from "bun:test";

import { err, ok, type Result } from "../../../src/result";
import {
  BM25RetrieverError,
  HybridMemorySearch,
  ReciprocalRankFusionPolicy,
  VectorRetrieverError,
  WeightedSumPolicy,
  type BM25Retriever,
  type BM25SearchResult,
  type VectorRetriever,
  type VectorSearchResult,
} from "../../../src/memory/search/index";

function createBm25Result(overrides: Partial<BM25SearchResult> & { memoryId: string }): BM25SearchResult {
  return {
    memoryId: overrides.memoryId,
    content: overrides.content ?? `BM25 content ${overrides.memoryId}`,
    type: overrides.type ?? "fact",
    layer: overrides.layer ?? "stm",
    importance: overrides.importance ?? 0.5,
    bm25Score: overrides.bm25Score ?? 0,
    snippet: overrides.snippet ?? "snippet",
  };
}

function createVectorResult(
  overrides: Partial<VectorSearchResult> & { memoryId: string },
): VectorSearchResult {
  return {
    memoryId: overrides.memoryId,
    content: overrides.content ?? `Vector content ${overrides.memoryId}`,
    type: overrides.type ?? "fact",
    layer: overrides.layer ?? "stm",
    importance: overrides.importance ?? 0.5,
    similarity: overrides.similarity ?? 0,
    embeddingMetadata: overrides.embeddingMetadata ?? {
      provider: "mock",
      model: "mock-model",
      dimension: 3,
    },
  };
}

function createBm25Retriever(
  value: Result<BM25SearchResult[], BM25RetrieverError>,
): BM25Retriever {
  return {
    search() {
      return value;
    },
  } as unknown as BM25Retriever;
}

function createVectorRetriever(
  value: Result<VectorSearchResult[], VectorRetrieverError>,
): VectorRetriever {
  return {
    async search() {
      return value;
    },
  } as unknown as VectorRetriever;
}

describe("WeightedSumPolicy", () => {
  test("produces expected weighted score with importance boost", () => {
    const policy = new WeightedSumPolicy();
    const score = policy.fuse({
      bm25Score: 0.8,
      vectorScore: 0.4,
      importance: 0.5,
      bm25Weight: 0.3,
      vectorWeight: 0.7,
      importanceBoost: 0.1,
    });

    expect(score).toBeCloseTo(0.57, 6);
  });
});

describe("ReciprocalRankFusionPolicy", () => {
  test("produces expected normalized RRF score", () => {
    const policy = new ReciprocalRankFusionPolicy(60);
    const score = policy.fuse({
      bm25Score: 0,
      vectorScore: 0,
      importance: 0,
      bm25Weight: 0,
      vectorWeight: 0,
      importanceBoost: 0,
      bm25Rank: 1,
      vectorRank: 2,
    });

    const expected = (1 / 61 + 1 / 62) / (2 / 61);
    expect(score).toBeCloseTo(expected, 6);
  });
});

describe("HybridMemorySearch", () => {
  test("merges BM25 and vector results into one ranked list", async () => {
    const bm25Retriever = createBm25Retriever(
      ok([
        createBm25Result({ memoryId: "m1", bm25Score: 0.9 }),
        createBm25Result({ memoryId: "m2", bm25Score: 0.3 }),
      ]),
    );

    const vectorRetriever = createVectorRetriever(
      ok([
        createVectorResult({ memoryId: "m3", similarity: 0.95 }),
        createVectorResult({ memoryId: "m1", similarity: 0.4 }),
      ]),
    );

    const search = new HybridMemorySearch({ bm25Retriever, vectorRetriever });
    const result = await search.search("typescript", { limit: 10 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBe(3);
    expect(result.value.map((item) => item.memoryId).sort()).toEqual(["m1", "m2", "m3"]);
  });

  test("deduplicates memories that appear in both retrievers", async () => {
    const bm25Retriever = createBm25Retriever(
      ok([
        createBm25Result({ memoryId: "shared", bm25Score: 0.8 }),
        createBm25Result({ memoryId: "bm25-only", bm25Score: 0.5 }),
      ]),
    );

    const vectorRetriever = createVectorRetriever(
      ok([
        createVectorResult({ memoryId: "shared", similarity: 0.9 }),
        createVectorResult({ memoryId: "vector-only", similarity: 0.7 }),
      ]),
    );

    const search = new HybridMemorySearch({ bm25Retriever, vectorRetriever });
    const result = await search.search("query");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBe(3);
    const shared = result.value.find((item) => item.memoryId === "shared");
    expect(shared).toBeDefined();
    expect(shared?.breakdown.bm25Score).toBe(0.8);
    expect(shared?.breakdown.vectorScore).toBe(0.9);
  });

  test("weight tuning changes ranking when BM25 weight is high", async () => {
    const bm25Retriever = createBm25Retriever(
      ok([
        createBm25Result({ memoryId: "bm25-best", bm25Score: 0.95, importance: 0.2 }),
        createBm25Result({ memoryId: "vector-best", bm25Score: 0.1, importance: 0.2 }),
      ]),
    );

    const vectorRetriever = createVectorRetriever(
      ok([
        createVectorResult({ memoryId: "vector-best", similarity: 0.95, importance: 0.2 }),
        createVectorResult({ memoryId: "bm25-best", similarity: 0.1, importance: 0.2 }),
      ]),
    );

    const search = new HybridMemorySearch({ bm25Retriever, vectorRetriever });
    const result = await search.search("query", {
      bm25Weight: 0.95,
      vectorWeight: 0.05,
      importanceBoost: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value[0]?.memoryId).toBe("bm25-best");
  });

  test("importance boost increases rank for high-importance memories", async () => {
    const bm25Retriever = createBm25Retriever(
      ok([
        createBm25Result({ memoryId: "low-importance", bm25Score: 0.5, importance: 0.1 }),
        createBm25Result({ memoryId: "high-importance", bm25Score: 0.45, importance: 0.95 }),
      ]),
    );

    const vectorRetriever = createVectorRetriever(ok([]));
    const search = new HybridMemorySearch({ bm25Retriever, vectorRetriever });

    const noBoost = await search.search("query", { importanceBoost: 0 });
    expect(noBoost.ok).toBe(true);
    if (!noBoost.ok) {
      return;
    }
    expect(noBoost.value[0]?.memoryId).toBe("low-importance");

    const boosted = await search.search("query", { importanceBoost: 0.5 });
    expect(boosted.ok).toBe(true);
    if (!boosted.ok) {
      return;
    }
    expect(boosted.value[0]?.memoryId).toBe("high-importance");
  });

  test("returns accurate score breakdown for explainability", async () => {
    const bm25Retriever = createBm25Retriever(
      ok([createBm25Result({ memoryId: "m1", bm25Score: 0.6, importance: 0.7 })]),
    );

    const vectorRetriever = createVectorRetriever(
      ok([createVectorResult({ memoryId: "m1", similarity: 0.8, importance: 0.7 })]),
    );

    const search = new HybridMemorySearch({ bm25Retriever, vectorRetriever });
    const result = await search.search("query", {
      bm25Weight: 0.3,
      vectorWeight: 0.7,
      importanceBoost: 0.1,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const item = result.value[0];
    expect(item?.breakdown.bm25Score).toBe(0.6);
    expect(item?.breakdown.vectorScore).toBe(0.8);
    expect(item?.breakdown.bm25Weight).toBeCloseTo(0.3, 6);
    expect(item?.breakdown.vectorWeight).toBeCloseTo(0.7, 6);
    expect(item?.breakdown.importanceBoost).toBeCloseTo(0.07, 6);
    expect(item?.score).toBeCloseTo(0.81, 6);
    expect(item?.source.type).toBe("memory");
  });

  test("uses BM25-only results when vector retriever fails", async () => {
    const bm25Retriever = createBm25Retriever(
      ok([createBm25Result({ memoryId: "m1", bm25Score: 0.9 })]),
    );

    const vectorRetriever = createVectorRetriever(
      err(new VectorRetrieverError("provider unavailable", "VECTOR_RETRIEVER_EMBEDDING_FAILED")),
    );

    const search = new HybridMemorySearch({ bm25Retriever, vectorRetriever });
    const result = await search.search("query");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBe(1);
    expect(result.value[0]?.memoryId).toBe("m1");
    expect(result.value[0]?.breakdown.vectorScore).toBe(0);
  });

  test("returns empty array when both retrievers return no results", async () => {
    const search = new HybridMemorySearch({
      bm25Retriever: createBm25Retriever(ok([])),
      vectorRetriever: createVectorRetriever(ok([])),
    });

    const result = await search.search("query");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("handles case where all results appear in both retrievers", async () => {
    const bm25Retriever = createBm25Retriever(
      ok([
        createBm25Result({ memoryId: "m1", bm25Score: 0.9 }),
        createBm25Result({ memoryId: "m2", bm25Score: 0.8 }),
      ]),
    );
    const vectorRetriever = createVectorRetriever(
      ok([
        createVectorResult({ memoryId: "m1", similarity: 0.6 }),
        createVectorResult({ memoryId: "m2", similarity: 0.7 }),
      ]),
    );

    const search = new HybridMemorySearch({ bm25Retriever, vectorRetriever });
    const result = await search.search("query");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBe(2);
    expect(result.value.map((item) => item.memoryId).sort()).toEqual(["m1", "m2"]);
    expect(result.value[0]?.memoryId).toBe("m2");
  });

  test("applies minScore filtering to fused results", async () => {
    const bm25Retriever = createBm25Retriever(
      ok([
        createBm25Result({ memoryId: "high", bm25Score: 0.95 }),
        createBm25Result({ memoryId: "low", bm25Score: 0.1 }),
      ]),
    );
    const vectorRetriever = createVectorRetriever(ok([]));

    const search = new HybridMemorySearch({ bm25Retriever, vectorRetriever });
    const result = await search.search("query", {
      minScore: 0.2,
      importanceBoost: 0,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBe(1);
    expect(result.value[0]?.memoryId).toBe("high");
  });
});
