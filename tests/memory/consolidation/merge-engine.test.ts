import { describe, expect, it } from "bun:test";

import type { DistilledFact } from "../../../src/memory/consolidation/distillation-schema";
import {
  ImportanceScorer,
  type ImportanceLevel,
} from "../../../src/memory/consolidation/importance-scorer";
import {
  MergeEngine,
  SimpleMemoryLookup,
} from "../../../src/memory/consolidation/merge-engine";
import type { MemoryRecord } from "../../../src/memory/types";

function makeLtmRecord(
  id: string,
  overrides?: Partial<MemoryRecord>,
): MemoryRecord {
  const now = new Date("2026-02-13T12:00:00.000Z");
  return {
    id,
    content: `Record ${id}`,
    type: "fact",
    layer: "ltm",
    tags: ["general"],
    entities: ["user"],
    importance: 0.5,
    confidence: 0.8,
    provenance: {
      sourceType: "implicit",
      conversationId: "conv-existing",
    },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    ...overrides,
  };
}

function makeFact(overrides?: Partial<DistilledFact>): DistilledFact {
  return {
    type: "fact",
    content: "User prefers concise responses",
    confidence: 0.9,
    sourceCandidateIds: ["cand-1"],
    entities: ["user", "response-style"],
    tags: ["preference"],
    reasoning: "The user stated this preference clearly.",
    ...overrides,
  };
}

function makeEngine(
  config?: {
    similarityThreshold?: number;
    maxSupersessionChainDepth?: number;
    minConfidenceToMerge?: number;
  },
): MergeEngine {
  let nextId = 0;
  const now = new Date("2026-02-14T08:00:00.000Z");
  const scorer = new ImportanceScorer({
    reinforcementBoost: 0.25,
    decayRate: 0.1,
    decayWindowMs: 24 * 60 * 60 * 1000,
  });

  return new MergeEngine({
    lookup: new SimpleMemoryLookup(),
    scorer,
    config: {
      similarityThreshold: config?.similarityThreshold ?? 1,
      maxSupersessionChainDepth: config?.maxSupersessionChainDepth ?? 8,
      minConfidenceToMerge: config?.minConfidenceToMerge ?? 0.5,
      now: () => now,
      generateId: () => `ltm-new-${++nextId}`,
    },
  });
}

describe("MergeEngine", () => {
  it("creates a new LTM record for a new fact", () => {
    const engine = makeEngine();
    const result = engine.merge([makeFact()], []);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toHaveLength(1);
    expect(result.value.updated).toHaveLength(0);
    expect(result.value.superseded).toHaveLength(0);
    expect(result.value.skipped).toHaveLength(0);
    expect(result.value.created[0].record.provenance.sourceType).toBe("consolidation");
  });

  it("reinforces existing record when duplicate fact is merged", () => {
    const engine = makeEngine();
    const existing = makeLtmRecord("ltm-1", {
      type: "fact",
      content: "User prefers concise responses",
      importance: 0.4,
      entities: ["user", "response-style"],
      tags: ["preference"],
    });

    const result = engine.merge([makeFact()], [existing]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toHaveLength(0);
    expect(result.value.updated).toHaveLength(1);
    expect(result.value.updated[0].record.id).toBe("ltm-1");
    expect(result.value.updated[0].record.importance).toBeGreaterThan(0.4);
    expect(result.value.skipped.some((entry) => entry.reason === "duplicate")).toBe(true);
  });

  it("supersedes contradictory fact with newer-wins strategy", () => {
    const engine = makeEngine();
    const oldFact = makeLtmRecord("ltm-old", {
      type: "fact",
      content: "User does not like morning standups",
      entities: ["user", "meeting"],
      tags: ["preference"],
    });

    const incoming = makeFact({
      content: "User likes morning standups",
      entities: ["user", "meeting"],
      tags: ["preference"],
    });

    const result = engine.merge([incoming], [oldFact]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toHaveLength(1);
    expect(result.value.superseded).toHaveLength(1);
    expect(result.value.superseded[0].record.id).toBe("ltm-old");
    expect(result.value.superseded[0].record.supersededBy).toBe("ltm-new-1");
    expect(result.value.created[0].record.supersedes).toBe("ltm-old");
    expect(result.value.supersessionChain).toHaveLength(1);
    expect(result.value.supersessionChain[0].originalId).toBe("ltm-old");
    expect(result.value.supersessionChain[0].replacedById).toBe("ltm-new-1");
  });

  it("produces traversable supersession chain metadata", () => {
    const engine = makeEngine();
    const base = makeLtmRecord("base", {
      type: "fact",
      content: "User does not prefer pair programming",
      entities: ["user", "workflow"],
      tags: ["preference"],
    });

    const firstMerge = engine.merge([
      makeFact({
        content: "User prefers pair programming",
        entities: ["user", "workflow"],
        tags: ["preference"],
        sourceCandidateIds: ["cand-a"],
      }),
    ], [base]);
    expect(firstMerge.ok).toBe(true);
    if (!firstMerge.ok) return;

    const forward = firstMerge.value.supersessionChain[0];
    expect(forward.originalId).toBe("base");
    expect(forward.replacedById).toBe("ltm-new-1");

    const backwardPointer = firstMerge.value.created[0].record.supersedes;
    expect(backwardPointer).toBe("base");
  });

  it("handles mixed batches with new, duplicate, contradiction, and low confidence", () => {
    const engine = makeEngine();
    const existing = [
      makeLtmRecord("dup", {
        type: "fact",
        content: "User prefers concise responses",
        entities: ["user", "response-style"],
        tags: ["preference"],
      }),
      makeLtmRecord("contradict", {
        type: "fact",
        content: "User does not use dark mode",
        entities: ["user", "theme"],
        tags: ["ui"],
      }),
    ];

    const result = engine.merge([
      makeFact(),
      makeFact({
        content: "User uses dark mode",
        entities: ["user", "theme"],
        tags: ["ui"],
        sourceCandidateIds: ["cand-2"],
      }),
      makeFact({
        content: "User likes keyboard shortcuts",
        entities: ["user", "workflow"],
        tags: ["productivity"],
        sourceCandidateIds: ["cand-3"],
      }),
      makeFact({
        content: "Potentially noisy weak signal",
        confidence: 0.2,
        sourceCandidateIds: ["cand-4"],
      }),
    ], existing);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.created).toHaveLength(2);
    expect(result.value.updated).toHaveLength(1);
    expect(result.value.superseded).toHaveLength(1);
    expect(result.value.skipped.some((entry) => entry.reason === "low_confidence")).toBe(true);
    expect(result.value.supersessionChain).toHaveLength(1);
  });

  it("returns empty merge result for empty fact array", () => {
    const engine = makeEngine();
    const result = engine.merge([], [makeLtmRecord("existing")]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toHaveLength(0);
    expect(result.value.updated).toHaveLength(0);
    expect(result.value.superseded).toHaveLength(0);
    expect(result.value.skipped).toHaveLength(0);
    expect(result.value.supersessionChain).toHaveLength(0);
  });

  it("enforces supersession chain depth limit", () => {
    const engine = makeEngine({ maxSupersessionChainDepth: 1 });
    const root = makeLtmRecord("root", {
      content: "User prefers vim for editing",
      entities: ["user", "editor", "vim"],
      tags: ["preference"],
    });
    const child = makeLtmRecord("child", {
      content: "User prefers emacs for editing",
      entities: ["user", "editor", "emacs"],
      tags: ["preference"],
      supersedes: "root",
      updatedAt: new Date("2026-02-13T13:00:00.000Z"),
    });

    const result = engine.merge([
      makeFact({
        content: "User prefers vscode for editing",
        entities: ["user", "editor", "vscode"],
        tags: ["preference"],
      }),
    ], [root, child]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.created).toHaveLength(0);
    expect(
      result.value.skipped.some((entry) => entry.reason === "supersession_chain_depth_exceeded"),
    ).toBe(true);
  });

  it("keeps source traceability metadata on created and updated outputs", () => {
    const engine = makeEngine();
    const existing = makeLtmRecord("trace-dup", {
      content: "User prefers concise responses",
      entities: ["user", "response-style"],
      tags: ["preference"],
    });

    const result = engine.merge([
      makeFact({ sourceCandidateIds: ["cand-dup"], reasoning: "duplicate source" }),
      makeFact({
        content: "User enjoys async communication",
        entities: ["user", "communication"],
        tags: ["preference"],
        sourceCandidateIds: ["cand-new-a", "cand-new-b"],
        reasoning: "multiple sources support this",
      }),
    ], [existing]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.updated[0].sourceCandidateIds).toEqual(["cand-dup"]);
    expect(result.value.created[0].sourceCandidateIds).toEqual(["cand-new-a", "cand-new-b"]);
    expect(result.value.created[0].reasoning).toBe("multiple sources support this");
  });
});

describe("ImportanceScorer", () => {
  it("increases numeric score with reinforcement and diminishing returns", () => {
    const scorer = new ImportanceScorer({ reinforcementBoost: 0.3 });

    const once = scorer.reinforce(0.4, 1);
    const many = scorer.reinforce(0.4, 4);

    expect(once).toBeGreaterThan(0.4);
    expect(many).toBeGreaterThan(once);
    expect(many).toBeLessThanOrEqual(1);
  });

  it("reduces numeric score based on decay window and rate", () => {
    const scorer = new ImportanceScorer({
      decayRate: 0.1,
      decayWindowMs: 24 * 60 * 60 * 1000,
    });
    const now = new Date("2026-02-14T12:00:00.000Z");
    const old = new Date("2026-02-10T12:00:00.000Z");

    const decayed = scorer.decay(0.8, old, now);
    expect(decayed).toBeLessThan(0.8);
  });

  it("maps score bands to importance levels", () => {
    const scorer = new ImportanceScorer();

    const levels: ImportanceLevel[] = [
      scorer.computeLevel(0.1),
      scorer.computeLevel(0.4),
      scorer.computeLevel(0.7),
      scorer.computeLevel(0.95),
    ];

    expect(levels).toEqual(["low", "medium", "high", "critical"]);
  });
});
