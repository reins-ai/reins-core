import { describe, expect, it } from "bun:test";
import { ok } from "../../../src/result";
import type {
  ConversationContext,
  Nudge,
  NudgeDecision,
  NudgeRetrievalResult,
} from "../../../src/memory/proactive/nudge-engine";
import {
  NudgeInjector,
  type NudgeEvaluator,
  type NudgeInjectorLogger,
} from "../../../src/memory/proactive/nudge-injector";
import type { MemoryRecord } from "../../../src/memory/types/memory-record";
import type { NudgeFeedbackStore } from "../../../src/memory/proactive/nudge-feedback-store";

// ---------------------------------------------------------------------------
// Helpers — build realistic mock data
// ---------------------------------------------------------------------------

function createMemoryRecord(index: number): MemoryRecord {
  const now = new Date();
  return {
    id: `mem-${index}`,
    content: `Memory content for record ${index}: This is a realistic-length memory entry that contains contextual information about user preferences, past decisions, and relevant facts that the nudge engine would typically retrieve from the vector store during evaluation.`,
    type: "fact",
    layer: "ltm",
    tags: [`tag-${index}`, `category-${index % 10}`, "general"],
    entities: [`entity-${index}`],
    importance: 0.5 + (index % 5) * 0.1,
    confidence: 0.8 + (index % 3) * 0.05,
    provenance: {
      sourceType: "explicit",
      conversationId: `conv-${index % 20}`,
    },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
  };
}

function createNudge(index: number): Nudge {
  return {
    id: `nudge-${index}`,
    content: `Nudge content ${index}: Remember that the user prefers concise responses with code examples when discussing technical topics.`,
    memorySource: createMemoryRecord(index),
    relevanceScore: 0.85 + (index % 3) * 0.05,
    reason: `Relevant fact memory (${(85 + (index % 3) * 5)}% match)`,
    type: "context",
    dismissible: true,
  };
}

function createContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    query: overrides.query ?? "Help me prioritize my tasks for today based on deadlines and importance",
    conversationId: overrides.conversationId ?? "conv-perf-test",
    recentTopics: overrides.recentTopics ?? ["planning", "productivity", "deadlines"],
  };
}

/**
 * Build a mock vector store with N records. The evaluator iterates all records
 * to simulate realistic filtering work (relevance scoring, cooldown checks, etc.)
 * but resolves synchronously — no real I/O.
 */
function createMockEvaluatorWithRecords(recordCount: number): NudgeEvaluator {
  const records: NudgeRetrievalResult[] = [];
  for (let i = 0; i < recordCount; i++) {
    records.push({
      id: `mem-${i}`,
      content: createMemoryRecord(i).content,
      score: 0.5 + (i % 5) * 0.1,
      record: createMemoryRecord(i),
    });
  }

  return {
    evaluate: async (_context: ConversationContext) => {
      // Simulate realistic work: filter, sort, and select top nudges
      const filtered = records.filter((r) => r.score >= 0.7);
      const sorted = filtered.sort((a, b) => b.score - a.score);
      const selected = sorted.slice(0, 3);

      const nudges: Nudge[] = selected.map((r, i) => createNudge(i));

      const decision: NudgeDecision = {
        shouldNudge: nudges.length > 0,
        nudges,
        reasoning: `Selected ${nudges.length} nudge(s) from ${records.length} candidates`,
      };

      return ok(decision);
    },
  };
}

function createNoopLogger(): NudgeInjectorLogger {
  return {
    debug: () => {},
    warn: () => {},
  };
}

function createMockFeedbackStore(): NudgeFeedbackStore {
  return {
    dismissTopic: () => {},
    isTopicDismissed: () => false,
    getDismissedTopics: () => [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("NudgeInjector latency profiling", () => {
  it("completes injectNudges under 50ms over 10 iterations with 100+ record mock store", async () => {
    const evaluator = createMockEvaluatorWithRecords(150);
    const injector = new NudgeInjector({
      nudgeEngine: evaluator,
      feedbackStore: createMockFeedbackStore(),
      config: {
        nudgesEnabled: true,
        maxEvaluationMs: 50,
      },
      logger: createNoopLogger(),
    });

    const context = createContext();
    const systemPrompt = "You are a helpful personal assistant that manages tasks and schedules.";
    const iterations = 10;

    // Warm-up iteration to avoid JIT compilation skewing results
    await injector.injectNudges(context, systemPrompt);

    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      const result = await injector.injectNudges(context, systemPrompt);
      const duration = performance.now() - start;

      expect(duration).toBeLessThan(50);
      // Verify nudges were actually injected (not skipped)
      expect(result).toContain("Nudge addendum:");
    }
  });

  it("timing gate skips injection when evaluation exceeds 50ms threshold", async () => {
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];

    // Use injected clock to deterministically simulate >50ms evaluation
    const clockValues = [
      // First call to this.now() — start timestamp
      1000,
      // Second call to this.now() — end timestamp (75ms later, exceeds 50ms gate)
      1075,
    ];

    const injector = new NudgeInjector({
      nudgeEngine: {
        evaluate: async () => {
          return ok({
            shouldNudge: true,
            nudges: [createNudge(0)],
            reasoning: "Would nudge but should be skipped",
          });
        },
      },
      config: {
        nudgesEnabled: true,
        maxEvaluationMs: 50,
      },
      now: () => {
        const value = clockValues.shift();
        return value ?? 1075;
      },
      logger: {
        debug: () => {},
        warn: (message, context) => {
          warnings.push({ message, context });
        },
      },
    });

    const systemPrompt = "You are a helpful assistant.";
    const result = await injector.injectNudges(createContext(), systemPrompt);

    // Prompt should be unchanged — nudges were skipped
    expect(result).toBe(systemPrompt);
    expect(result).not.toContain("Nudge addendum:");

    // Warning should have been logged about latency gate
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("latency gate");
    expect(warnings[0].context?.durationMs).toBe(75);
    expect(warnings[0].context?.maxEvaluationMs).toBe(50);
  });

  it("timing gate skips at exactly the boundary (duration > threshold, not >=)", async () => {
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];

    // 51ms — just over the 50ms threshold
    const clockValues = [1000, 1051];

    const injector = new NudgeInjector({
      nudgeEngine: {
        evaluate: async () => {
          return ok({
            shouldNudge: true,
            nudges: [createNudge(0)],
            reasoning: "Would nudge",
          });
        },
      },
      config: {
        nudgesEnabled: true,
        maxEvaluationMs: 50,
      },
      now: () => {
        const value = clockValues.shift();
        return value ?? 1051;
      },
      logger: {
        debug: () => {},
        warn: (message, context) => {
          warnings.push({ message, context });
        },
      },
    });

    const systemPrompt = "You are a helpful assistant.";
    const result = await injector.injectNudges(createContext(), systemPrompt);

    // 51ms > 50ms → should skip
    expect(result).toBe(systemPrompt);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].context?.durationMs).toBe(51);
  });

  it("allows injection when duration is exactly at threshold (50ms is not exceeded)", async () => {
    // 50ms — exactly at the threshold (not exceeded, since check is >)
    const clockValues = [1000, 1050];

    const injector = new NudgeInjector({
      nudgeEngine: {
        evaluate: async () => {
          return ok({
            shouldNudge: true,
            nudges: [createNudge(0)],
            reasoning: "Should nudge",
          });
        },
      },
      config: {
        nudgesEnabled: true,
        maxEvaluationMs: 50,
      },
      now: () => {
        const value = clockValues.shift();
        return value ?? 1050;
      },
      logger: createNoopLogger(),
    });

    const systemPrompt = "You are a helpful assistant.";
    const result = await injector.injectNudges(createContext(), systemPrompt);

    // 50ms is NOT > 50ms → should allow injection
    expect(result).toContain("Nudge addendum:");
  });

  it("handles large record counts (200 records) within latency budget", async () => {
    const evaluator = createMockEvaluatorWithRecords(200);
    const injector = new NudgeInjector({
      nudgeEngine: evaluator,
      feedbackStore: createMockFeedbackStore(),
      config: {
        nudgesEnabled: true,
        maxEvaluationMs: 50,
      },
      logger: createNoopLogger(),
    });

    const context = createContext();
    const systemPrompt = "You are a helpful assistant.";

    // Warm-up
    await injector.injectNudges(context, systemPrompt);

    const start = performance.now();
    const result = await injector.injectNudges(context, systemPrompt);
    const duration = performance.now() - start;

    expect(duration).toBeLessThan(50);
    expect(result).toContain("Nudge addendum:");
  });
});
