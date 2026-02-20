import { describe, expect, it } from "bun:test";
import { ok } from "../../../src/result";
import type { ConversationContext, Nudge } from "../../../src/memory/proactive/nudge-engine";
import { NudgeInjector } from "../../../src/memory/proactive/nudge-injector";
import type { MemoryRecord } from "../../../src/memory/types/memory-record";

function createMemoryRecord(id: string): MemoryRecord {
  const now = new Date();
  return {
    id,
    content: `Memory content ${id}`,
    type: "fact",
    layer: "ltm",
    tags: [],
    entities: [],
    importance: 0.7,
    confidence: 0.9,
    provenance: {
      sourceType: "explicit",
      conversationId: "conv-1",
    },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
  };
}

function createNudge(id: string, content: string): Nudge {
  return {
    id,
    content,
    memorySource: createMemoryRecord(id),
    relevanceScore: 0.86,
    reason: "Relevant fact memory",
    type: "context",
    dismissible: true,
  };
}

function createContext(overrides: Partial<ConversationContext> = {}): ConversationContext {
  return {
    query: overrides.query ?? "Help me prioritize tasks",
    conversationId: overrides.conversationId ?? "conv-1",
    recentTopics: overrides.recentTopics ?? ["planning"],
  };
}

describe("NudgeInjector", () => {
  it("appends relevant nudges to the system prompt", async () => {
    let receivedContext: ConversationContext | null = null;
    const injector = new NudgeInjector({
      nudgeEngine: {
        evaluate: async (context) => {
          receivedContext = context;
          return ok({
            shouldNudge: true,
            nudges: [createNudge("n1", "User prefers TypeScript examples")],
            reasoning: "Selected one nudge",
          });
        },
      },
      config: {
        nudgesEnabled: true,
      },
    });

    const result = await injector.injectNudges(createContext(), "You are a helpful assistant.");

    expect(receivedContext?.conversationId).toBe("conv-1");
    expect(result).toContain("You are a helpful assistant.");
    expect(result).toContain("Nudge addendum:");
    expect(result).toContain("User prefers TypeScript examples");
  });

  it("skips nudge injection and logs when evaluation exceeds latency gate", async () => {
    const warnings: Array<{ message: string; context?: Record<string, unknown> }> = [];
    const clockValues = [1000, 1065];

    const injector = new NudgeInjector({
      nudgeEngine: {
        evaluate: async () => {
          return ok({
            shouldNudge: true,
            nudges: [createNudge("n1", "This should be skipped")],
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
        return value ?? 1065;
      },
      logger: {
        debug: () => {
          return;
        },
        warn: (message, context) => {
          warnings.push({ message, context });
        },
      },
    });

    const systemPrompt = "You are a helpful assistant.";
    const result = await injector.injectNudges(createContext(), systemPrompt);

    expect(result).toBe(systemPrompt);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].message).toContain("latency gate");
    expect(warnings[0].context?.durationMs).toBe(65);
  });

  it("returns unchanged prompt when nudges are disabled", async () => {
    let evaluateCalls = 0;
    const injector = new NudgeInjector({
      nudgeEngine: {
        evaluate: async () => {
          evaluateCalls += 1;
          return ok({
            shouldNudge: true,
            nudges: [createNudge("n1", "Should never be evaluated")],
            reasoning: "n/a",
          });
        },
      },
      config: {
        nudgesEnabled: false,
      },
    });

    const systemPrompt = "You are a helpful assistant.";
    const result = await injector.injectNudges(createContext(), systemPrompt);

    expect(result).toBe(systemPrompt);
    expect(evaluateCalls).toBe(0);
  });

  it("returns unchanged prompt when evaluation has no nudges", async () => {
    const injector = new NudgeInjector({
      nudgeEngine: {
        evaluate: async () => {
          return ok({
            shouldNudge: false,
            nudges: [],
            reasoning: "No relevant memories",
          });
        },
      },
      config: {
        nudgesEnabled: true,
      },
    });

    const systemPrompt = "You are a helpful assistant.";
    const result = await injector.injectNudges(createContext(), systemPrompt);

    expect(result).toBe(systemPrompt);
  });
});
