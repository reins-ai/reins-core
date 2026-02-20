import { describe, expect, it } from "bun:test";

import { err, ok } from "../../../src/result";
import { RagContextInjector } from "../../../src/memory/services/rag-context-injector";
import {
  UnifiedMemoryRetrievalError,
  type UnifiedMemoryRetrieval,
  type UnifiedSearchResult,
} from "../../../src/memory/search/unified-memory-retrieval";

const WORDS_PER_TOKEN = 0.75;

function createDocumentResult(options: {
  id: string;
  score: number;
  rank: number;
  sourcePath: string;
  content: string;
}): UnifiedSearchResult {
  return {
    id: options.id,
    source: "document",
    content: options.content,
    score: options.score,
    rank: options.rank,
    metadata: {
      sourcePath: options.sourcePath,
      heading: null,
      headingHierarchy: [],
      sourceId: `source-${options.id}`,
      chunkIndex: options.rank,
    },
  };
}

function estimateTokens(content: string): number {
  const words = content
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0).length;

  if (words === 0) {
    return 0;
  }

  return Math.ceil(words / WORDS_PER_TOKEN);
}

describe("RagContextInjector", () => {
  it("returns null when retrieval is not configured", async () => {
    const injector = new RagContextInjector({ retrieval: null });

    const context = await injector.getRelevantContext("what is in my docs?", 120);

    expect(context).toBeNull();
  });

  it("calls searchDocumentsOnly with topK=3 and formats citation blocks", async () => {
    const calls: Array<{ query: string; topK: number }> = [];
    const retrieval = {
      searchDocumentsOnly: async (query: string, topK: number) => {
        calls.push({ query, topK });
        return ok([
          createDocumentResult({
            id: "doc-1",
            score: 0.95,
            rank: 1,
            sourcePath: "docs/contract.md",
            content: "Section four states payment is due within thirty days.",
          }),
        ]);
      },
    } as unknown as UnifiedMemoryRetrieval;

    const injector = new RagContextInjector({ retrieval });
    const context = await injector.getRelevantContext("What does section 4 say?", 120);

    expect(calls).toEqual([{ query: "What does section 4 say?", topK: 3 }]);
    expect(context).toBe(
      "[Document context from: docs/contract.md]\nSection four states payment is due within thirty days.\n[End context]",
    );
  });

  it("returns null when no relevant documents are found", async () => {
    const retrieval = {
      searchDocumentsOnly: async () => ok([]),
    } as unknown as UnifiedMemoryRetrieval;

    const injector = new RagContextInjector({ retrieval });
    const context = await injector.getRelevantContext("find nothing", 80);

    expect(context).toBeNull();
  });

  it("returns null when document retrieval fails", async () => {
    const retrieval = {
      searchDocumentsOnly: async () =>
        err(
          new UnifiedMemoryRetrievalError(
            "search failed",
            "UNIFIED_MEMORY_RETRIEVAL_SOURCE_FAILURE",
          ),
        ),
    } as unknown as UnifiedMemoryRetrieval;

    const injector = new RagContextInjector({ retrieval });
    const context = await injector.getRelevantContext("search", 100);

    expect(context).toBeNull();
  });

  it("enforces token budget by truncating lower-scored chunks first", async () => {
    const retrieval = {
      searchDocumentsOnly: async () =>
        ok([
          createDocumentResult({
            id: "high",
            score: 0.99,
            rank: 1,
            sourcePath: "docs/high.md",
            content: "high alpha beta",
          }),
          createDocumentResult({
            id: "mid",
            score: 0.85,
            rank: 2,
            sourcePath: "docs/mid.md",
            content: "mid gamma delta",
          }),
          createDocumentResult({
            id: "low",
            score: 0.2,
            rank: 3,
            sourcePath: "docs/low.md",
            content:
              "low one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen",
          }),
        ]),
    } as unknown as UnifiedMemoryRetrieval;

    const injector = new RagContextInjector({ retrieval });
    const maxTokens = 26;
    const context = await injector.getRelevantContext("summarize docs", maxTokens);

    expect(context).not.toBeNull();
    expect(context).toContain("[Document context from: docs/high.md]");
    expect(context).toContain("[Document context from: docs/mid.md]");
    expect(context).not.toContain("[Document context from: docs/low.md]");
    expect(estimateTokens(context ?? "")).toBeLessThanOrEqual(maxTokens);
  });
});
