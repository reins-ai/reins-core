import { describe, expect, it } from "bun:test";
import { err, ok, type Result } from "../../../src/result";
import { ConversationRetrievalError } from "../../../src/memory/search/conversation-retrieval-service";
import type {
  MemoryPrimingContract,
  MemoryPrimingItem,
  PreferenceOptions,
  PrimingContext,
  TurnContextParams,
} from "../../../src/conversation/memory-priming-contract";
import {
  ContextPacker,
  type ContextPackerConfig,
} from "../../../src/conversation/context/context-packer";
import {
  MemoryPrimingMiddleware,
  type PrimingConfig,
} from "../../../src/conversation/middleware/memory-priming-middleware";

function createMemory(
  id: string,
  overrides: Partial<MemoryPrimingItem> = {},
): MemoryPrimingItem {
  return {
    id,
    content: overrides.content ?? `Memory ${id}`,
    type: overrides.type ?? "fact",
    importance: overrides.importance ?? 0.5,
    relevanceScore: overrides.relevanceScore ?? 0.5,
    source: overrides.source ?? "memory",
    tokenEstimate: overrides.tokenEstimate ?? 8,
  };
}

class MockRetrievalService implements MemoryPrimingContract {
  public lastTurnParams: TurnContextParams | null = null;

  constructor(
    private readonly result: Result<PrimingContext, ConversationRetrievalError>,
  ) {}

  async getContextForTurn(
    params: TurnContextParams,
  ): Promise<Result<PrimingContext, ConversationRetrievalError>> {
    this.lastTurnParams = params;
    return this.result;
  }

  async getUserPreferences(
    _options?: PreferenceOptions,
  ): Promise<Result<MemoryPrimingItem[], ConversationRetrievalError>> {
    return ok([]);
  }
}

function createConfig(overrides: Partial<PrimingConfig> = {}): PrimingConfig {
  return {
    enabled: true,
    maxTokens: 120,
    maxMemories: 3,
    minRelevanceScore: 0.5,
    topicWeight: 1,
    ...overrides,
  };
}

describe("ContextPacker", () => {
  it("formats context in brief mode with sources", () => {
    const packer = new ContextPacker();
    const memories = [
      createMemory("m-1", {
        type: "preference",
        content: "User prefers TypeScript",
        relevanceScore: 0.9,
        importance: 0.8,
        source: "explicit, conversation:conv-1",
      }),
    ];
    const config: ContextPackerConfig = {
      tokenBudget: 100,
      format: "brief",
      includeSources: true,
    };

    const packed = packer.pack(memories, config);

    expect(packed.memoriesIncluded).toBe(1);
    expect(packed.memoriesTruncated).toBe(0);
    expect(packed.text).toContain("Relevant memory context:");
    expect(packed.text).toContain("[preference]");
    expect(packed.text).toContain("source: explicit, conversation:conv-1");
    expect(packed.tokensUsed).toBeGreaterThan(0);
  });
});

describe("MemoryPrimingMiddleware", () => {
  it("returns packed context when retrieval succeeds", async () => {
    const retrievalService = new MockRetrievalService(
      ok({
        memories: [
          createMemory("m-1", {
            content: "User prefers concise responses",
            relevanceScore: 0.92,
            importance: 0.7,
          }),
        ],
        totalTokenEstimate: 20,
        truncated: false,
      }),
    );
    const middleware = new MemoryPrimingMiddleware({
      retrievalService,
      config: createConfig(),
    });

    const result = await middleware.prime({
      recentMessages: ["Can you keep answers brief?"],
      currentTopic: "response style",
      sessionId: "conv-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesUsed).toBe(1);
    expect(result.value.context).toContain("User prefers concise responses");
    expect(result.value.tokensUsed).toBeGreaterThan(0);
    expect(result.value.memoriesSkipped).toBe(0);
    expect(result.value.latencyMs).toBeGreaterThanOrEqual(0);
    expect(retrievalService.lastTurnParams?.conversationId).toBe("conv-1");
    expect(retrievalService.lastTurnParams?.query).toContain("response style");
  });

  it("enforces token budget and truncates overflow memories", async () => {
    const retrievalService = new MockRetrievalService(
      ok({
        memories: [
          createMemory("m-1", {
            content: "A".repeat(200),
            relevanceScore: 0.95,
            importance: 0.9,
          }),
          createMemory("m-2", {
            content: "B".repeat(200),
            relevanceScore: 0.9,
            importance: 0.7,
          }),
        ],
        totalTokenEstimate: 200,
        truncated: false,
      }),
    );
    const middleware = new MemoryPrimingMiddleware({
      retrievalService,
      config: createConfig({ maxTokens: 45, maxMemories: 5, minRelevanceScore: 0 }),
    });

    const result = await middleware.prime({
      recentMessages: ["Help me remember preferences"],
      sessionId: "conv-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesUsed).toBe(0);
    expect(result.value.memoriesSkipped).toBe(2);
    expect(result.value.tokensUsed).toBe(0);
    expect(result.value.context).toBe("");
  });

  it("filters memories below relevance threshold", async () => {
    const retrievalService = new MockRetrievalService(
      ok({
        memories: [
          createMemory("m-1", { relevanceScore: 0.91 }),
          createMemory("m-2", { relevanceScore: 0.3 }),
          createMemory("m-3", { relevanceScore: 0.8 }),
        ],
        totalTokenEstimate: 30,
        truncated: false,
      }),
    );
    const middleware = new MemoryPrimingMiddleware({
      retrievalService,
      config: createConfig({ minRelevanceScore: 0.75, maxMemories: 5 }),
    });

    const result = await middleware.prime({
      recentMessages: ["What do you know about me?"],
      sessionId: "conv-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesUsed).toBe(2);
    expect(result.value.context).toContain("m-1");
    expect(result.value.context).toContain("m-3");
    expect(result.value.context).not.toContain("m-2");
    expect(result.value.memoriesSkipped).toBe(1);
  });

  it("returns empty priming when retrieval is empty", async () => {
    const retrievalService = new MockRetrievalService(
      ok({
        memories: [],
        totalTokenEstimate: 0,
        truncated: false,
      }),
    );
    const middleware = new MemoryPrimingMiddleware({
      retrievalService,
      config: createConfig(),
    });

    const result = await middleware.prime({
      recentMessages: ["No memory should match this"],
      sessionId: "conv-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.context).toBe("");
    expect(result.value.memoriesUsed).toBe(0);
    expect(result.value.memoriesSkipped).toBe(0);
  });

  it("gracefully degrades when retrieval fails", async () => {
    const retrievalService = new MockRetrievalService(
      err(
        new ConversationRetrievalError(
          "hybrid unavailable",
          "CONVERSATION_RETRIEVAL_SEARCH_FAILED",
        ),
      ),
    );
    const middleware = new MemoryPrimingMiddleware({
      retrievalService,
      config: createConfig(),
    });

    const result = await middleware.prime({
      recentMessages: ["Need memory context"],
      sessionId: "conv-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.context).toBe("");
    expect(result.value.memoriesUsed).toBe(0);
    expect(result.value.memoriesSkipped).toBe(0);
  });

  it("prioritizes memories by relevance then importance", async () => {
    const retrievalService = new MockRetrievalService(
      ok({
        memories: [
          createMemory("m-low", { relevanceScore: 0.6, importance: 0.95 }),
          createMemory("m-high", { relevanceScore: 0.9, importance: 0.2 }),
          createMemory("m-mid", { relevanceScore: 0.8, importance: 0.9 }),
        ],
        totalTokenEstimate: 60,
        truncated: false,
      }),
    );
    const middleware = new MemoryPrimingMiddleware({
      retrievalService,
      config: createConfig({ maxMemories: 2, minRelevanceScore: 0 }),
    });

    const result = await middleware.prime({
      recentMessages: ["What should I remember?"],
      sessionId: "conv-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.memoriesUsed).toBe(2);
    const highIndex = result.value.context.indexOf("m-high");
    const midIndex = result.value.context.indexOf("m-mid");
    expect(highIndex).toBeGreaterThan(-1);
    expect(midIndex).toBeGreaterThan(-1);
    expect(highIndex).toBeLessThan(midIndex);
    expect(result.value.context).not.toContain("m-low");
  });

  it("skips priming when disabled", async () => {
    const retrievalService = new MockRetrievalService(
      ok({
        memories: [createMemory("m-1", { relevanceScore: 0.9 })],
        totalTokenEstimate: 10,
        truncated: false,
      }),
    );
    const middleware = new MemoryPrimingMiddleware({
      retrievalService,
      config: createConfig({ enabled: false }),
    });

    const result = await middleware.prime({
      recentMessages: ["message"],
      sessionId: "conv-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.context).toBe("");
    expect(result.value.memoriesUsed).toBe(0);
    expect(retrievalService.lastTurnParams).toBeNull();
  });

  it("tracks latency in priming result", async () => {
    const retrievalService = new MockRetrievalService(
      ok({
        memories: [createMemory("m-1", { relevanceScore: 0.9 })],
        totalTokenEstimate: 12,
        truncated: false,
      }),
    );
    const middleware = new MemoryPrimingMiddleware({
      retrievalService,
      config: createConfig(),
    });

    const result = await middleware.prime({
      recentMessages: ["message"],
      sessionId: "conv-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(result.value.latencyMs)).toBe(true);
  });
});
