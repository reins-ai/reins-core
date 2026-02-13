import { describe, expect, it } from "bun:test";
import { ok, err } from "../../../src/result";
import type { Result } from "../../../src/result";
import type {
  HybridMemorySearch,
  HybridSearchOptions,
  HybridSearchResult,
} from "../../../src/memory/search/hybrid-memory-search";
import { HybridMemorySearchError } from "../../../src/memory/search/hybrid-memory-search";
import {
  ConversationRetrievalService,
  ConversationRetrievalError,
} from "../../../src/memory/search/conversation-retrieval-service";
import type { MemoryType, MemoryLayer } from "../../../src/memory/types/index";

function makeSearchResult(overrides: Partial<HybridSearchResult> & { memoryId: string }): HybridSearchResult {
  return {
    memoryId: overrides.memoryId,
    content: overrides.content ?? `Content for ${overrides.memoryId}`,
    type: overrides.type ?? "fact",
    layer: overrides.layer ?? "ltm",
    importance: overrides.importance ?? 0.5,
    score: overrides.score ?? 0.8,
    breakdown: overrides.breakdown ?? {
      bm25Score: 0.3,
      vectorScore: 0.7,
      importanceBoost: 0.05,
      bm25Weight: 0.3,
      vectorWeight: 0.7,
    },
    source: overrides.source ?? { type: "memory" },
  };
}

function createMockSearch(
  results: HybridSearchResult[] = [],
  shouldFail = false,
): HybridMemorySearch {
  return {
    search: async (
      _query: string,
      _options?: HybridSearchOptions,
    ): Promise<Result<HybridSearchResult[], HybridMemorySearchError>> => {
      if (shouldFail) {
        return err(
          new HybridMemorySearchError(
            "Search failed",
            "HYBRID_MEMORY_SEARCH_RETRIEVERS_FAILED",
          ),
        );
      }

      return ok(results);
    },
  } as HybridMemorySearch;
}

function createFilteringMockSearch(
  results: HybridSearchResult[],
): HybridMemorySearch {
  return {
    search: async (
      _query: string,
      options?: HybridSearchOptions,
    ): Promise<Result<HybridSearchResult[], HybridMemorySearchError>> => {
      let filtered = results;

      if (options?.memoryTypes && options.memoryTypes.length > 0) {
        const types = new Set(options.memoryTypes);
        filtered = filtered.filter((r) => types.has(r.type));
      }

      if (options?.limit) {
        filtered = filtered.slice(0, options.limit);
      }

      return ok(filtered);
    },
  } as HybridMemorySearch;
}

describe("ConversationRetrievalService", () => {
  describe("getContextForTurn", () => {
    it("returns relevant memories for a query", async () => {
      const results = [
        makeSearchResult({ memoryId: "mem-1", content: "User likes TypeScript", score: 0.9 }),
        makeSearchResult({ memoryId: "mem-2", content: "User prefers dark mode", score: 0.7 }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "What does the user prefer?",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories).toHaveLength(2);
      expect(result.value.memories[0].id).toBe("mem-1");
      expect(result.value.memories[0].content).toBe("User likes TypeScript");
      expect(result.value.memories[0].relevanceScore).toBe(0.9);
      expect(result.value.memories[1].id).toBe("mem-2");
      expect(result.value.totalTokenEstimate).toBeGreaterThan(0);
    });

    it("returns empty context for empty query", async () => {
      const mockSearch = createMockSearch([
        makeSearchResult({ memoryId: "mem-1" }),
      ]);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "   ",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories).toHaveLength(0);
      expect(result.value.totalTokenEstimate).toBe(0);
      expect(result.value.truncated).toBe(false);
    });

    it("enforces token budget and sets truncated flag", async () => {
      const longContent = "A".repeat(400);
      const results = [
        makeSearchResult({ memoryId: "mem-1", content: longContent, score: 0.9 }),
        makeSearchResult({ memoryId: "mem-2", content: longContent, score: 0.8 }),
        makeSearchResult({ memoryId: "mem-3", content: longContent, score: 0.7 }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test query",
        conversationId: "conv-1",
        maxTokenBudget: 150,
        maxItems: 10,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories.length).toBeLessThan(3);
      expect(result.value.truncated).toBe(true);
      expect(result.value.totalTokenEstimate).toBeLessThanOrEqual(150);
    });

    it("enforces maxItems limit", async () => {
      const results = [
        makeSearchResult({ memoryId: "mem-1", content: "short", score: 0.9 }),
        makeSearchResult({ memoryId: "mem-2", content: "short", score: 0.8 }),
        makeSearchResult({ memoryId: "mem-3", content: "short", score: 0.7 }),
        makeSearchResult({ memoryId: "mem-4", content: "short", score: 0.6 }),
        makeSearchResult({ memoryId: "mem-5", content: "short", score: 0.5 }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test query",
        conversationId: "conv-1",
        maxItems: 2,
        maxTokenBudget: 10000,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories).toHaveLength(2);
      expect(result.value.truncated).toBe(true);
    });

    it("filters out excludeIds", async () => {
      const results = [
        makeSearchResult({ memoryId: "mem-1", content: "first", score: 0.9 }),
        makeSearchResult({ memoryId: "mem-2", content: "second", score: 0.8 }),
        makeSearchResult({ memoryId: "mem-3", content: "third", score: 0.7 }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test query",
        conversationId: "conv-1",
        excludeIds: ["mem-1", "mem-3"],
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories).toHaveLength(1);
      expect(result.value.memories[0].id).toBe("mem-2");
    });

    it("returns error when hybrid search fails", async () => {
      const mockSearch = createMockSearch([], true);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test query",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(ConversationRetrievalError);
      expect(result.error.code).toBe("CONVERSATION_RETRIEVAL_SEARCH_FAILED");
    });

    it("returns empty context when search returns no results", async () => {
      const mockSearch = createMockSearch([]);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "obscure query with no matches",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories).toHaveLength(0);
      expect(result.value.totalTokenEstimate).toBe(0);
      expect(result.value.truncated).toBe(false);
    });

    it("uses default maxTokenBudget and maxItems when not specified", async () => {
      const results = Array.from({ length: 8 }, (_, i) =>
        makeSearchResult({
          memoryId: `mem-${i}`,
          content: `Memory content ${i}`,
          score: 0.9 - i * 0.05,
        }),
      );
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test query",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories.length).toBeLessThanOrEqual(5);
    });

    it("includes token estimates for each memory item", async () => {
      const results = [
        makeSearchResult({ memoryId: "mem-1", content: "Hello world test content here" }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const item = result.value.memories[0];
      expect(item.tokenEstimate).toBeGreaterThan(0);
      expect(item.tokenEstimate).toBe(Math.ceil("Hello world test content here".length / 4));
    });

    it("formats source with conversation ID when present", async () => {
      const results = [
        makeSearchResult({
          memoryId: "mem-1",
          source: { type: "explicit", conversationId: "conv-abc" },
        }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories[0].source).toBe("explicit, conversation:conv-abc");
    });

    it("formats source without conversation ID when absent", async () => {
      const results = [
        makeSearchResult({
          memoryId: "mem-1",
          source: { type: "memory" },
        }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories[0].source).toBe("memory");
    });

    it("sets truncated when first item exceeds token budget", async () => {
      const longContent = "A".repeat(8000);
      const results = [
        makeSearchResult({ memoryId: "mem-1", content: longContent, score: 0.9 }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test",
        conversationId: "conv-1",
        maxTokenBudget: 100,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories).toHaveLength(0);
      expect(result.value.truncated).toBe(true);
      expect(result.value.totalTokenEstimate).toBe(0);
    });

    it("preserves memory type from search results", async () => {
      const results = [
        makeSearchResult({ memoryId: "mem-1", type: "preference" as MemoryType }),
        makeSearchResult({ memoryId: "mem-2", type: "decision" as MemoryType }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories[0].type).toBe("preference");
      expect(result.value.memories[1].type).toBe("decision");
    });
  });

  describe("getUserPreferences", () => {
    it("returns preferences sorted by importance descending", async () => {
      const results = [
        makeSearchResult({
          memoryId: "pref-1",
          type: "preference",
          importance: 0.6,
          content: "Prefers dark mode",
        }),
        makeSearchResult({
          memoryId: "pref-2",
          type: "preference",
          importance: 0.9,
          content: "Prefers TypeScript",
        }),
        makeSearchResult({
          memoryId: "pref-3",
          type: "preference",
          importance: 0.7,
          content: "Prefers tabs",
        }),
      ];
      const mockSearch = createFilteringMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getUserPreferences();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
      expect(result.value[0].importance).toBe(0.9);
      expect(result.value[1].importance).toBe(0.7);
      expect(result.value[2].importance).toBe(0.6);
    });

    it("filters by minImportance", async () => {
      const results = [
        makeSearchResult({
          memoryId: "pref-1",
          type: "preference",
          importance: 0.3,
          content: "Low importance pref",
        }),
        makeSearchResult({
          memoryId: "pref-2",
          type: "preference",
          importance: 0.8,
          content: "High importance pref",
        }),
      ];
      const mockSearch = createFilteringMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getUserPreferences({ minImportance: 0.5 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe("pref-2");
    });

    it("applies limit to results", async () => {
      const results = Array.from({ length: 10 }, (_, i) =>
        makeSearchResult({
          memoryId: `pref-${i}`,
          type: "preference" as MemoryType,
          importance: 0.9 - i * 0.03,
          content: `Preference ${i}`,
        }),
      );
      const mockSearch = createFilteringMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getUserPreferences({ limit: 3 });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(3);
    });

    it("returns empty array when no preferences exist", async () => {
      const mockSearch = createFilteringMockSearch([]);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getUserPreferences();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toHaveLength(0);
    });

    it("returns error when hybrid search fails", async () => {
      const mockSearch = createMockSearch([], true);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getUserPreferences();

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(ConversationRetrievalError);
      expect(result.error.code).toBe("CONVERSATION_RETRIEVAL_SEARCH_FAILED");
    });

    it("uses default limit and minImportance when not specified", async () => {
      const results = Array.from({ length: 15 }, (_, i) =>
        makeSearchResult({
          memoryId: `pref-${i}`,
          type: "preference" as MemoryType,
          importance: 0.9 - i * 0.05,
          content: `Preference ${i}`,
        }),
      );
      const mockSearch = createFilteringMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getUserPreferences();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.length).toBeLessThanOrEqual(10);
      for (const item of result.value) {
        expect(item.importance).toBeGreaterThanOrEqual(0.5);
      }
    });

    it("only returns preference type memories", async () => {
      const results = [
        makeSearchResult({
          memoryId: "pref-1",
          type: "preference",
          importance: 0.8,
          content: "User prefers dark mode",
        }),
        makeSearchResult({
          memoryId: "fact-1",
          type: "fact",
          importance: 0.9,
          content: "User works at Acme Corp",
        }),
      ];
      const mockSearch = createFilteringMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getUserPreferences();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      for (const item of result.value) {
        expect(item.type).toBe("preference");
      }
    });
  });

  describe("token estimation", () => {
    it("estimates tokens as approximately content length / 4", async () => {
      const content = "This is a test string with some words";
      const results = [
        makeSearchResult({ memoryId: "mem-1", content }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const expectedTokens = Math.ceil(content.length / 4);
      expect(result.value.memories[0].tokenEstimate).toBe(expectedTokens);
      expect(result.value.totalTokenEstimate).toBe(expectedTokens);
    });

    it("returns at least 1 token for non-empty content", async () => {
      const results = [
        makeSearchResult({ memoryId: "mem-1", content: "Hi" }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch });

      const result = await service.getContextForTurn({
        query: "test",
        conversationId: "conv-1",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.memories[0].tokenEstimate).toBeGreaterThanOrEqual(1);
    });
  });

  describe("logger integration", () => {
    it("calls logger.debug during successful retrieval", async () => {
      const debugCalls: Array<{ message: string; context?: Record<string, unknown> }> = [];
      const logger = {
        debug(message: string, context?: Record<string, unknown>) {
          debugCalls.push({ message, context });
        },
        warn() {},
        error() {},
      };

      const results = [
        makeSearchResult({ memoryId: "mem-1" }),
      ];
      const mockSearch = createMockSearch(results);
      const service = new ConversationRetrievalService({ search: mockSearch, logger });

      await service.getContextForTurn({
        query: "test",
        conversationId: "conv-1",
      });

      expect(debugCalls.length).toBeGreaterThanOrEqual(2);
      expect(debugCalls[0].message).toContain("Retrieving context");
      expect(debugCalls[1].message).toContain("Turn context retrieved");
    });

    it("calls logger.error when search fails", async () => {
      const errorCalls: Array<{ message: string; context?: Record<string, unknown> }> = [];
      const logger = {
        debug() {},
        warn() {},
        error(message: string, context?: Record<string, unknown>) {
          errorCalls.push({ message, context });
        },
      };

      const mockSearch = createMockSearch([], true);
      const service = new ConversationRetrievalService({ search: mockSearch, logger });

      await service.getContextForTurn({
        query: "test",
        conversationId: "conv-1",
      });

      expect(errorCalls.length).toBeGreaterThanOrEqual(1);
      expect(errorCalls[0].message).toContain("Hybrid search failed");
    });
  });
});
