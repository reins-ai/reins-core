import { describe, expect, it } from "bun:test";
import { err, ok, type Result } from "../../../src/result";
import { ReinsError } from "../../../src/errors";
import type { MemoryRecord } from "../../../src/memory/types/memory-record";
import type { MemoryType } from "../../../src/memory/types/memory-types";
import {
  NudgeEngine,
  type ConversationContext,
  type NudgeConfig,
  type NudgeMemoryRetrieval,
  type NudgeRetrievalResult,
} from "../../../src/memory/proactive/nudge-engine";
import {
  NudgeFeedbackStore,
  type NudgeFeedback,
} from "../../../src/memory/proactive/nudge-feedback-store";

function createMemoryRecord(
  id: string,
  overrides: Partial<MemoryRecord> = {},
): MemoryRecord {
  const now = new Date();
  return {
    id,
    content: overrides.content ?? `Memory content for ${id}`,
    type: overrides.type ?? "fact",
    layer: overrides.layer ?? "ltm",
    tags: overrides.tags ?? [],
    entities: overrides.entities ?? [],
    importance: overrides.importance ?? 0.5,
    confidence: overrides.confidence ?? 0.8,
    provenance: overrides.provenance ?? {
      sourceType: "explicit",
      conversationId: "conv-1",
    },
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    accessedAt: overrides.accessedAt ?? now,
  };
}

function createRetrievalResult(
  id: string,
  score: number,
  recordOverrides: Partial<MemoryRecord> = {},
): NudgeRetrievalResult {
  const record = createMemoryRecord(id, recordOverrides);
  return {
    id,
    content: record.content,
    score,
    record,
  };
}

function createConfig(overrides: Partial<NudgeConfig> = {}): NudgeConfig {
  return {
    enabled: overrides.enabled ?? true,
    maxNudgesPerTurn: overrides.maxNudgesPerTurn ?? 3,
    minRelevanceScore: overrides.minRelevanceScore ?? 0.3,
    cooldownMs: overrides.cooldownMs ?? 60_000,
    nudgeTypes: overrides.nudgeTypes ?? [],
    dismissedTopicWindowMs: overrides.dismissedTopicWindowMs ?? 3_600_000,
  };
}

function createContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    query: overrides.query ?? "What should I work on today?",
    conversationId: overrides.conversationId ?? "conv-test-1",
    recentTopics: overrides.recentTopics ?? [],
  };
}

class MockRetrieval implements NudgeMemoryRetrieval {
  public lastQuery: string | null = null;
  public lastOptions: { topK: number; types?: MemoryType[] } | null = null;

  constructor(
    private readonly result: Result<NudgeRetrievalResult[]>,
  ) {}

  async search(
    query: string,
    options: { topK: number; types?: MemoryType[] },
  ): Promise<Result<NudgeRetrievalResult[]>> {
    this.lastQuery = query;
    this.lastOptions = options;
    return this.result;
  }
}

describe("NudgeFeedbackStore", () => {
  it("records and retrieves feedback", () => {
    const store = new NudgeFeedbackStore();
    const feedback: NudgeFeedback = {
      nudgeId: "nudge-1",
      action: "dismissed",
      timestamp: new Date(),
      topic: "typescript",
    };

    store.recordFeedback(feedback);

    const all = store.getAllFeedback();
    expect(all).toHaveLength(1);
    expect(all[0].nudgeId).toBe("nudge-1");
    expect(all[0].action).toBe("dismissed");
    expect(all[0].topic).toBe("typescript");
  });

  it("returns dismissed topics within time window", () => {
    const store = new NudgeFeedbackStore();
    const now = Date.now();

    store.recordFeedback({
      nudgeId: "n1",
      action: "dismissed",
      timestamp: new Date(now - 1000),
      topic: "react",
    });
    store.recordFeedback({
      nudgeId: "n2",
      action: "accepted",
      timestamp: new Date(now - 500),
      topic: "typescript",
    });
    store.recordFeedback({
      nudgeId: "n3",
      action: "dismissed",
      timestamp: new Date(now - 200),
      topic: "testing",
    });

    const dismissed = store.getDismissedTopics(2000);
    expect(dismissed).toContain("react");
    expect(dismissed).toContain("testing");
    expect(dismissed).not.toContain("typescript");
  });

  it("excludes dismissed topics outside time window", () => {
    const store = new NudgeFeedbackStore();
    const now = Date.now();

    store.recordFeedback({
      nudgeId: "n1",
      action: "dismissed",
      timestamp: new Date(now - 10_000),
      topic: "old-topic",
    });
    store.recordFeedback({
      nudgeId: "n2",
      action: "dismissed",
      timestamp: new Date(now - 100),
      topic: "recent-topic",
    });

    const dismissed = store.getDismissedTopics(5000);
    expect(dismissed).not.toContain("old-topic");
    expect(dismissed).toContain("recent-topic");
  });

  it("calculates dismissal rate for a topic", () => {
    const store = new NudgeFeedbackStore();
    const now = new Date();

    store.recordFeedback({ nudgeId: "n1", action: "dismissed", timestamp: now, topic: "auth" });
    store.recordFeedback({ nudgeId: "n2", action: "dismissed", timestamp: now, topic: "auth" });
    store.recordFeedback({ nudgeId: "n3", action: "accepted", timestamp: now, topic: "auth" });
    store.recordFeedback({ nudgeId: "n4", action: "ignored", timestamp: now, topic: "auth" });

    const rate = store.getDismissalRate("auth");
    expect(rate).toBe(0.5);
  });

  it("returns zero dismissal rate for unknown topic", () => {
    const store = new NudgeFeedbackStore();
    expect(store.getDismissalRate("unknown")).toBe(0);
  });

  it("returns topic stats correctly", () => {
    const store = new NudgeFeedbackStore();
    const now = new Date();

    store.recordFeedback({ nudgeId: "n1", action: "dismissed", timestamp: now, topic: "db" });
    store.recordFeedback({ nudgeId: "n2", action: "accepted", timestamp: now, topic: "db" });
    store.recordFeedback({ nudgeId: "n3", action: "ignored", timestamp: now, topic: "db" });

    const stats = store.getTopicStats("db");
    expect(stats.dismissed).toBe(1);
    expect(stats.accepted).toBe(1);
    expect(stats.ignored).toBe(1);
    expect(stats.total).toBe(3);
  });

  it("serializes and deserializes round-trip", () => {
    const store = new NudgeFeedbackStore();
    const timestamp = new Date("2026-01-15T10:00:00Z");

    store.recordFeedback({ nudgeId: "n1", action: "dismissed", timestamp, topic: "react" });
    store.recordFeedback({ nudgeId: "n2", action: "accepted", timestamp, topic: "testing" });

    const json = store.serialize();
    const restored = NudgeFeedbackStore.deserialize(json);

    const all = restored.getAllFeedback();
    expect(all).toHaveLength(2);
    expect(all[0].nudgeId).toBe("n1");
    expect(all[0].action).toBe("dismissed");
    expect(all[0].topic).toBe("react");
    expect(all[0].timestamp.toISOString()).toBe(timestamp.toISOString());
    expect(all[1].nudgeId).toBe("n2");
    expect(all[1].action).toBe("accepted");
  });
});

describe("NudgeEngine", () => {
  it("generates nudges from relevant memories", async () => {
    const candidates = [
      createRetrievalResult("mem-1", 0.8, { content: "User prefers TypeScript" }),
      createRetrievalResult("mem-2", 0.6, { content: "Project uses Bun runtime" }),
    ];
    const retrieval = new MockRetrieval(ok(candidates));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig();

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.shouldNudge).toBe(true);
    expect(result.value.nudges).toHaveLength(2);
    expect(result.value.nudges[0].content).toBe("User prefers TypeScript");
    expect(result.value.nudges[0].relevanceScore).toBe(0.8);
    expect(result.value.nudges[0].dismissible).toBe(true);
    expect(result.value.nudges[1].content).toBe("Project uses Bun runtime");
  });

  it("filters memories below relevance threshold", async () => {
    const candidates = [
      createRetrievalResult("mem-1", 0.8, { content: "High relevance" }),
      createRetrievalResult("mem-2", 0.1, { content: "Low relevance" }),
      createRetrievalResult("mem-3", 0.05, { content: "Very low relevance" }),
    ];
    const retrieval = new MockRetrieval(ok(candidates));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig({ minRelevanceScore: 0.3 });

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.shouldNudge).toBe(true);
    expect(result.value.nudges).toHaveLength(1);
    expect(result.value.nudges[0].content).toBe("High relevance");
    expect(result.value.reasoning).toContain("below relevance threshold");
  });

  it("enforces cooldown for same memory", async () => {
    const candidates = [
      createRetrievalResult("mem-1", 0.8, { content: "Repeated memory" }),
    ];
    const retrieval = new MockRetrieval(ok(candidates));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig({ cooldownMs: 60_000 });

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });

    const firstResult = await engine.evaluate(createContext());
    expect(firstResult.ok).toBe(true);
    if (!firstResult.ok) return;
    expect(firstResult.value.shouldNudge).toBe(true);
    expect(firstResult.value.nudges).toHaveLength(1);

    const secondResult = await engine.evaluate(createContext());
    expect(secondResult.ok).toBe(true);
    if (!secondResult.ok) return;
    expect(secondResult.value.shouldNudge).toBe(false);
    expect(secondResult.value.nudges).toHaveLength(0);
    expect(secondResult.value.reasoning).toContain("cooldown");
  });

  it("limits nudges per turn", async () => {
    const candidates = [
      createRetrievalResult("mem-1", 0.9),
      createRetrievalResult("mem-2", 0.85),
      createRetrievalResult("mem-3", 0.8),
      createRetrievalResult("mem-4", 0.75),
      createRetrievalResult("mem-5", 0.7),
    ];
    const retrieval = new MockRetrieval(ok(candidates));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig({ maxNudgesPerTurn: 2 });

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.nudges).toHaveLength(2);
  });

  it("suppresses nudges for dismissed topics", async () => {
    const candidates = [
      createRetrievalResult("mem-1", 0.8, {
        content: "User prefers dark mode for typescript projects",
        tags: ["typescript"],
      }),
      createRetrievalResult("mem-2", 0.7, {
        content: "Project uses React framework",
        tags: ["react"],
      }),
    ];
    const retrieval = new MockRetrieval(ok(candidates));
    const feedbackStore = new NudgeFeedbackStore();

    feedbackStore.recordFeedback({
      nudgeId: "old-nudge",
      action: "dismissed",
      timestamp: new Date(),
      topic: "typescript",
    });

    const config = createConfig({ dismissedTopicWindowMs: 3_600_000 });
    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.nudges).toHaveLength(1);
    expect(result.value.nudges[0].content).toContain("React");
    expect(result.value.reasoning).toContain("dismissed");
  });

  it("returns empty nudges when no relevant memories found", async () => {
    const retrieval = new MockRetrieval(ok([]));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig();

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.shouldNudge).toBe(false);
    expect(result.value.nudges).toHaveLength(0);
    expect(result.value.reasoning).toContain("No relevant memories");
  });

  it("returns empty when engine is disabled", async () => {
    const retrieval = new MockRetrieval(ok([createRetrievalResult("mem-1", 0.9)]));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig({ enabled: false });

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.shouldNudge).toBe(false);
    expect(result.value.nudges).toHaveLength(0);
    expect(result.value.reasoning).toContain("disabled");
  });

  it("includes explainability payload in reasoning", async () => {
    const candidates = [
      createRetrievalResult("mem-1", 0.8, { content: "Important fact" }),
      createRetrievalResult("mem-2", 0.1, { content: "Irrelevant fact" }),
    ];
    const retrieval = new MockRetrieval(ok(candidates));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig({ minRelevanceScore: 0.5 });

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.reasoning).toContain("Selected 1 nudge(s)");
    expect(result.value.reasoning).toContain("below relevance threshold");
    expect(result.value.reasoning).toContain("mem-2");
  });

  it("degrades gracefully on retrieval failure", async () => {
    const retrieval = new MockRetrieval(
      err(new ReinsError("Search unavailable", "SEARCH_ERROR")),
    );
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig();

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.shouldNudge).toBe(false);
    expect(result.value.nudges).toHaveLength(0);
    expect(result.value.reasoning).toContain("retrieval unavailable");
  });

  it("assigns correct nudge types based on memory type", async () => {
    const candidates = [
      createRetrievalResult("mem-1", 0.8, { type: "preference" }),
      createRetrievalResult("mem-2", 0.7, { type: "decision" }),
      createRetrievalResult("mem-3", 0.6, { type: "skill" }),
    ];
    const retrieval = new MockRetrieval(ok(candidates));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig();

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.nudges[0].type).toBe("context");
    expect(result.value.nudges[1].type).toBe("reminder");
    expect(result.value.nudges[2].type).toBe("suggestion");
  });

  it("includes reason with relevance score in each nudge", async () => {
    const candidates = [
      createRetrievalResult("mem-1", 0.85, { type: "fact" }),
    ];
    const retrieval = new MockRetrieval(ok(candidates));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig();

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const nudge = result.value.nudges[0];
    expect(nudge.reason).toContain("fact");
    expect(nudge.reason).toContain("85%");
    expect(nudge.reason).toContain("explicit");
  });

  it("returns empty for blank query", async () => {
    const retrieval = new MockRetrieval(ok([createRetrievalResult("mem-1", 0.9)]));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig();

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext({ query: "   " }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.shouldNudge).toBe(false);
    expect(result.value.nudges).toHaveLength(0);
  });

  it("passes configured nudge types to retrieval", async () => {
    const retrieval = new MockRetrieval(ok([]));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig({ nudgeTypes: ["fact", "preference"] });

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    await engine.evaluate(createContext());

    expect(retrieval.lastOptions?.types).toEqual(["fact", "preference"]);
  });

  it("does not pass types filter when nudgeTypes is empty", async () => {
    const retrieval = new MockRetrieval(ok([]));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig({ nudgeTypes: [] });

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    await engine.evaluate(createContext());

    expect(retrieval.lastOptions?.types).toBeUndefined();
  });

  it("preserves memory source reference in nudge", async () => {
    const record = createMemoryRecord("mem-1", {
      content: "Important context",
      importance: 0.9,
      tags: ["critical"],
    });
    const candidates: NudgeRetrievalResult[] = [
      { id: "mem-1", content: record.content, score: 0.8, record },
    ];
    const retrieval = new MockRetrieval(ok(candidates));
    const feedbackStore = new NudgeFeedbackStore();
    const config = createConfig();

    const engine = new NudgeEngine({ retrieval, feedbackStore, config });
    const result = await engine.evaluate(createContext());

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const nudge = result.value.nudges[0];
    expect(nudge.memorySource).toBe(record);
    expect(nudge.memorySource.importance).toBe(0.9);
    expect(nudge.memorySource.tags).toEqual(["critical"]);
  });
});
