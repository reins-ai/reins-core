import { describe, expect, test } from "bun:test";

import { ok, type Result } from "../../../src/result";
import {
  UnifiedMemoryRetrieval,
  type DocumentSearchProvider,
  type DocumentSearchResult,
  type MemorySearchProvider,
  type MemorySearchResult,
  type UnifiedMemoryRetrievalDependencies,
} from "../../../src/memory/search/unified-memory-retrieval";

class MockMemorySearchProvider implements MemorySearchProvider {
  readonly calls: Array<{
    query: string;
    options: {
      topK: number;
      types?: string[];
      layers?: string[];
      minImportance?: number;
    };
  }> = [];

  private readonly response: Result<MemorySearchResult[]>;

  constructor(response: Result<MemorySearchResult[]>) {
    this.response = response;
  }

  async search(
    query: string,
    options: {
      topK: number;
      types?: string[];
      layers?: string[];
      minImportance?: number;
    },
  ): Promise<Result<MemorySearchResult[]>> {
    this.calls.push({ query, options });
    return this.response;
  }
}

class MockDocumentSearchProvider implements DocumentSearchProvider {
  readonly calls: Array<{
    query: string;
    topK: number;
    filters?: { sourceIds?: string[] };
  }> = [];

  private readonly response: Result<DocumentSearchResult[]>;

  constructor(response: Result<DocumentSearchResult[]>) {
    this.response = response;
  }

  async search(
    query: string,
    topK: number,
    filters?: { sourceIds?: string[] },
  ): Promise<Result<DocumentSearchResult[]>> {
    this.calls.push({ query, topK, filters });
    return this.response;
  }
}

function createMemoryResult(overrides: Partial<MemorySearchResult> & { id: string }): MemorySearchResult {
  return {
    id: overrides.id,
    content: overrides.content ?? `memory:${overrides.id}`,
    score: overrides.score ?? 0,
    type: overrides.type ?? "fact",
    layer: overrides.layer ?? "stm",
    importance: overrides.importance ?? 0.5,
    tags: overrides.tags ?? [],
    conversationId: overrides.conversationId,
    provenance: overrides.provenance,
  };
}

function createDocumentResult(
  overrides: Partial<DocumentSearchResult> & { chunkId: string },
): DocumentSearchResult {
  return {
    chunkId: overrides.chunkId,
    content: overrides.content ?? `document:${overrides.chunkId}`,
    score: overrides.score ?? 0,
    sourcePath: overrides.sourcePath ?? "/docs/default.md",
    heading: overrides.heading ?? null,
    headingHierarchy: overrides.headingHierarchy ?? [],
    sourceId: overrides.sourceId ?? "source-default",
    chunkIndex: overrides.chunkIndex ?? 0,
  };
}

function createService(options: {
  memoryResults?: MemorySearchResult[];
  documentResults?: DocumentSearchResult[];
  config?: UnifiedMemoryRetrievalDependencies["config"];
}): {
  service: UnifiedMemoryRetrieval;
  memoryProvider: MockMemorySearchProvider;
  documentProvider: MockDocumentSearchProvider;
} {
  const memoryProvider = new MockMemorySearchProvider(ok(options.memoryResults ?? []));
  const documentProvider = new MockDocumentSearchProvider(ok(options.documentResults ?? []));

  const service = new UnifiedMemoryRetrieval({
    memorySearch: memoryProvider,
    documentSearch: documentProvider,
    config: options.config,
  });

  return { service, memoryProvider, documentProvider };
}

describe("UnifiedMemoryRetrieval", () => {
  test("returns unified ranked results from memory and document sources", async () => {
    const { service } = createService({
      memoryResults: [createMemoryResult({ id: "m1", score: 0.9 })],
      documentResults: [createDocumentResult({ chunkId: "d1", score: 0.8 })],
    });

    const result = await service.search({ query: "unified retrieval" });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBe(2);
    expect(result.value.map((item) => item.source).sort()).toEqual(["document", "memory"]);
  });

  test("supports source filtering for memory-only and document-only search", async () => {
    const { service, memoryProvider, documentProvider } = createService({
      memoryResults: [createMemoryResult({ id: "m1", score: 0.9 })],
      documentResults: [createDocumentResult({ chunkId: "d1", score: 0.9 })],
    });

    const memoryOnly = await service.search({
      query: "filter",
      sources: ["memory"],
    });
    expect(memoryOnly.ok).toBe(true);
    if (memoryOnly.ok) {
      expect(memoryOnly.value.length).toBe(1);
      expect(memoryOnly.value[0]?.source).toBe("memory");
    }

    const documentOnly = await service.searchDocumentsOnly("filter", 5);
    expect(documentOnly.ok).toBe(true);
    if (documentOnly.ok) {
      expect(documentOnly.value.length).toBe(1);
      expect(documentOnly.value[0]?.source).toBe("document");
    }

    expect(memoryProvider.calls.length).toBe(1);
    expect(documentProvider.calls.length).toBe(1);
  });

  test("normalizes heterogeneous source scores before merge", async () => {
    const { service } = createService({
      memoryResults: [
        createMemoryResult({ id: "m-high", score: 100 }),
        createMemoryResult({ id: "m-low", score: 20 }),
      ],
      documentResults: [
        createDocumentResult({ chunkId: "d-high", score: 1 }),
        createDocumentResult({ chunkId: "d-low", score: 0.2 }),
      ],
      config: {
        memoryWeight: 0.5,
        documentWeight: 0.5,
        normalizeScores: true,
      },
    });

    const result = await service.search({ query: "scales", minScore: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const memoryTop = result.value.find((item) => item.id === "m-high");
    const docTop = result.value.find((item) => item.id === "d-high");
    expect(memoryTop?.score).toBeCloseTo(docTop?.score ?? -1, 6);
  });

  test("applies source weights to ranking", async () => {
    const { service } = createService({
      memoryResults: [createMemoryResult({ id: "m1", score: 0.9 })],
      documentResults: [createDocumentResult({ chunkId: "d1", score: 0.9 })],
      config: {
        memoryWeight: 0.8,
        documentWeight: 0.2,
      },
    });

    const result = await service.search({ query: "weighted", minScore: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value[0]?.source).toBe("memory");
    expect(result.value[0]?.score).toBeGreaterThan(result.value[1]?.score ?? 0);
  });

  test("enforces global topK limiting after merge", async () => {
    const { service } = createService({
      memoryResults: [
        createMemoryResult({ id: "m1", score: 0.9 }),
        createMemoryResult({ id: "m2", score: 0.8 }),
      ],
      documentResults: [
        createDocumentResult({ chunkId: "d1", score: 0.95 }),
        createDocumentResult({ chunkId: "d2", score: 0.85 }),
      ],
    });

    const result = await service.search({ query: "topk", topK: 2, minScore: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
    }
  });

  test("applies minimum score filtering after weighting", async () => {
    const { service } = createService({
      memoryResults: [
        createMemoryResult({ id: "m-strong", score: 0.9 }),
        createMemoryResult({ id: "m-weak", score: 0.1 }),
      ],
      documentResults: [],
    });

    const result = await service.search({ query: "minimum", minScore: 0.5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((item) => item.id)).toEqual(["m-strong"]);
    }
  });

  test("passes memory filters to memory provider", async () => {
    const { service, memoryProvider } = createService({
      memoryResults: [createMemoryResult({ id: "m1", score: 0.9 })],
      documentResults: [],
    });

    const result = await service.search({
      query: "filters",
      memoryFilters: {
        types: ["preference"],
        layers: ["ltm"],
        minImportance: 0.7,
      },
      sources: ["memory"],
    });

    expect(result.ok).toBe(true);
    expect(memoryProvider.calls).toHaveLength(1);
    expect(memoryProvider.calls[0]?.options).toEqual({
      topK: 20,
      types: ["preference"],
      layers: ["ltm"],
      minImportance: 0.7,
    });
  });

  test("applies document filters for sourceIds and paths", async () => {
    const { service, documentProvider } = createService({
      memoryResults: [],
      documentResults: [
        createDocumentResult({
          chunkId: "d-keep",
          sourceId: "source-a",
          sourcePath: "/docs/keep/intro.md",
          score: 0.9,
        }),
        createDocumentResult({
          chunkId: "d-drop",
          sourceId: "source-a",
          sourcePath: "/docs/other/drop.md",
          score: 0.9,
        }),
      ],
    });

    const result = await service.search({
      query: "documents",
      sources: ["document"],
      documentFilters: {
        sourceIds: ["source-a"],
        paths: ["/docs/keep"],
      },
      minScore: 0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((item) => item.id)).toEqual(["d-keep"]);
    }

    expect(documentProvider.calls).toHaveLength(1);
    expect(documentProvider.calls[0]?.filters).toEqual({ sourceIds: ["source-a"] });
  });

  test("returns empty result for empty source payloads", async () => {
    const { service } = createService({ memoryResults: [], documentResults: [] });
    const result = await service.search({ query: "nothing" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("returns available results when one source is empty", async () => {
    const { service } = createService({
      memoryResults: [createMemoryResult({ id: "m1", score: 0.9 })],
      documentResults: [],
    });

    const result = await service.search({ query: "partial", minScore: 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]?.source).toBe("memory");
    }
  });

  test("returns source-specific metadata and provenance", async () => {
    const { service } = createService({
      memoryResults: [
        createMemoryResult({
          id: "m1",
          score: 0.9,
          type: "preference",
          layer: "ltm",
          importance: 0.95,
          tags: ["ux"],
          conversationId: "conv-1",
          provenance: {
            source: "explicit",
            extractedAt: "2026-02-13T10:00:00.000Z",
            extractionVersion: "v1",
          },
        }),
      ],
      documentResults: [
        createDocumentResult({
          chunkId: "d1",
          score: 0.9,
          sourcePath: "/docs/guide.md",
          heading: "Guide",
          headingHierarchy: ["Guide"],
          sourceId: "source-1",
          chunkIndex: 3,
        }),
      ],
    });

    const result = await service.search({ query: "metadata", minScore: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const memory = result.value.find((item) => item.source === "memory");
    const document = result.value.find((item) => item.source === "document");
    expect(memory?.metadata).toEqual({
      type: "preference",
      layer: "ltm",
      importance: 0.95,
      tags: ["ux"],
      conversationId: "conv-1",
    });
    expect(memory?.provenance?.source).toBe("explicit");
    expect(document?.metadata).toEqual({
      sourcePath: "/docs/guide.md",
      heading: "Guide",
      headingHierarchy: ["Guide"],
      sourceId: "source-1",
      chunkIndex: 3,
    });
  });

  test("assigns rank positions based on final ordering", async () => {
    const { service } = createService({
      memoryResults: [
        createMemoryResult({ id: "m1", score: 0.9 }),
        createMemoryResult({ id: "m2", score: 0.7 }),
      ],
      documentResults: [createDocumentResult({ chunkId: "d1", score: 0.95 })],
      config: {
        normalizeScores: false,
        memoryWeight: 1,
        documentWeight: 1,
      },
    });

    const result = await service.search({ query: "ranked", minScore: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.map((item) => item.rank)).toEqual([1, 2, 3]);
    expect(result.value[0]?.id).toBe("d1");
  });
});
