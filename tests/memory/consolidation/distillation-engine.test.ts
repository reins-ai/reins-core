import { describe, expect, it } from "bun:test";

import { DistillationEngine } from "../../../src/memory/consolidation/distillation-engine";
import {
  DEFAULT_DISTILLATION_CONFIG,
  validateDistilledFact,
} from "../../../src/memory/consolidation/distillation-schema";
import type { StmBatch } from "../../../src/memory/consolidation/stm-queue";
import type { MemoryRecord } from "../../../src/memory/types";

function makeRecord(id: string, overrides?: Partial<MemoryRecord>): MemoryRecord {
  const now = new Date("2026-02-13T10:00:00.000Z");
  return {
    id,
    content: `Memory content for ${id}`,
    type: "fact",
    layer: "stm",
    tags: ["memory"],
    entities: [],
    importance: 0.7,
    confidence: 0.8,
    provenance: {
      sourceType: "implicit",
      conversationId: "conv-1",
    },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    ...overrides,
  };
}

function makeBatch(candidateIds: string[]): StmBatch {
  return {
    batchId: "batch-1",
    createdAt: new Date("2026-02-13T10:05:00.000Z"),
    candidates: candidateIds.map((id) => ({
      record: makeRecord(id),
      status: "eligible",
      retryCount: 0,
      batchId: "batch-1",
    })),
  };
}

describe("DistillationEngine", () => {
  it("returns validated distilled facts for valid provider JSON", async () => {
    const batch = makeBatch(["c-1", "c-2"]);
    const provider = async () => {
      return JSON.stringify({
        facts: [
          {
            type: "fact",
            content: "User works on TypeScript projects.",
            confidence: 0.91,
            sourceCandidateIds: ["c-1"],
            entities: ["TypeScript"],
            tags: ["work", "language"],
            reasoning: "Candidate c-1 states the user project stack.",
          },
          {
            type: "preference",
            content: "User prefers bun:test over other test runners.",
            confidence: 0.82,
            sourceCandidateIds: ["c-2"],
            entities: ["bun:test"],
            tags: ["testing", "preference"],
            reasoning: "Candidate c-2 explicitly states testing preference.",
          },
        ],
      });
    };

    const engine = new DistillationEngine({ provider });
    const result = await engine.distill(batch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.facts).toHaveLength(2);
    expect(result.value.failedCandidateIds).toEqual([]);
    expect(result.value.warnings).toHaveLength(0);
  });

  it("filters out facts below confidence threshold", async () => {
    const batch = makeBatch(["c-1", "c-2"]);
    const provider = async () => {
      return JSON.stringify({
        facts: [
          {
            type: "fact",
            content: "High-confidence fact",
            confidence: 0.7,
            sourceCandidateIds: ["c-1"],
            entities: [],
            tags: ["high"],
            reasoning: "Strong evidence.",
          },
          {
            type: "fact",
            content: "Low-confidence fact",
            confidence: 0.4,
            sourceCandidateIds: ["c-2"],
            entities: [],
            tags: ["low"],
            reasoning: "Weak evidence.",
          },
        ],
      });
    };

    const engine = new DistillationEngine({
      provider,
      config: { confidenceThreshold: 0.5 },
    });
    const result = await engine.distill(batch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.facts).toHaveLength(1);
    expect(result.value.facts[0].content).toBe("High-confidence fact");
    expect(result.value.failedCandidateIds).toEqual(["c-2"]);
    expect(result.value.warnings.some((warning) => warning.includes("confidence threshold"))).toBe(true);
  });

  it("handles malformed provider output gracefully", async () => {
    const batch = makeBatch(["c-1", "c-2"]);
    const provider = async () => "this is not json";
    const engine = new DistillationEngine({ provider });

    const result = await engine.distill(batch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.facts).toHaveLength(0);
    expect(result.value.failedCandidateIds).toEqual(["c-1", "c-2"]);
    expect(result.value.warnings.some((warning) => warning.includes("parse"))).toBe(true);
  });

  it("keeps valid facts when provider output has mixed valid and invalid entries", async () => {
    const batch = makeBatch(["c-1", "c-2"]);
    const provider = async () => {
      return JSON.stringify({
        facts: [
          {
            type: "decision",
            content: "Use constructor injection for providers.",
            confidence: 0.9,
            sourceCandidateIds: ["c-1"],
            entities: ["provider"],
            tags: ["architecture"],
            reasoning: "Candidate c-1 contains a clear design decision.",
          },
          {
            type: "unknown",
            content: "Invalid type should be rejected",
            confidence: 0.95,
            sourceCandidateIds: ["c-2"],
            entities: [],
            tags: [],
            reasoning: "Invalid type.",
          },
        ],
      });
    };
    const engine = new DistillationEngine({ provider });

    const result = await engine.distill(batch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.facts).toHaveLength(1);
    expect(result.value.facts[0].type).toBe("decision");
    expect(result.value.failedCandidateIds).toEqual(["c-2"]);
    expect(result.value.warnings.some((warning) => warning.includes("Rejected fact"))).toBe(true);
  });

  it("returns empty result for an empty batch without calling provider", async () => {
    const batch = makeBatch([]);
    let providerCalls = 0;
    const provider = async () => {
      providerCalls += 1;
      return "{}";
    };

    const engine = new DistillationEngine({ provider });
    const result = await engine.distill(batch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.facts).toHaveLength(0);
    expect(result.value.failedCandidateIds).toHaveLength(0);
    expect(providerCalls).toBe(0);
  });

  it("enforces source traceability against candidate IDs", async () => {
    const batch = makeBatch(["c-1", "c-2"]);
    const provider = async () => {
      return JSON.stringify({
        facts: [
          {
            type: "entity",
            content: "TypeScript",
            confidence: 0.88,
            sourceCandidateIds: ["c-1"],
            entities: ["TypeScript"],
            tags: ["language"],
            reasoning: "Candidate c-1 mentions TypeScript.",
          },
          {
            type: "fact",
            content: "Invalid source id fact",
            confidence: 0.86,
            sourceCandidateIds: ["unknown-id"],
            entities: [],
            tags: [],
            reasoning: "Should fail source validation.",
          },
        ],
      });
    };

    const engine = new DistillationEngine({ provider });
    const result = await engine.distill(batch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.facts).toHaveLength(1);
    expect(result.value.facts[0].sourceCandidateIds).toEqual(["c-1"]);
    expect(result.value.failedCandidateIds).toEqual(["c-2"]);
  });

  it("validates distilled fact schema for invalid type and out-of-range confidence", () => {
    const allowed = new Set(["c-1"]);
    const badType = validateDistilledFact(
      {
        type: "bad-type",
        content: "x",
        confidence: 0.8,
        sourceCandidateIds: ["c-1"],
        entities: [],
        tags: [],
        reasoning: "x",
      },
      allowed,
    );
    expect(badType.ok).toBe(false);

    const badConfidence = validateDistilledFact(
      {
        type: "fact",
        content: "x",
        confidence: 1.2,
        sourceCandidateIds: ["c-1"],
        entities: [],
        tags: [],
        reasoning: "x",
      },
      allowed,
    );
    expect(badConfidence.ok).toBe(false);
  });

  it("applies config overrides for max facts per batch", async () => {
    const batch = makeBatch(["c-1", "c-2", "c-3"]);
    const provider = async () => {
      return JSON.stringify({
        facts: [
          {
            type: "fact",
            content: "fact-1",
            confidence: 0.95,
            sourceCandidateIds: ["c-1"],
            entities: [],
            tags: [],
            reasoning: "x",
          },
          {
            type: "fact",
            content: "fact-2",
            confidence: 0.9,
            sourceCandidateIds: ["c-2"],
            entities: [],
            tags: [],
            reasoning: "x",
          },
          {
            type: "fact",
            content: "fact-3",
            confidence: 0.85,
            sourceCandidateIds: ["c-3"],
            entities: [],
            tags: [],
            reasoning: "x",
          },
        ],
      });
    };

    const engine = new DistillationEngine({
      provider,
      config: {
        maxFactsPerBatch: 2,
        confidenceThreshold: DEFAULT_DISTILLATION_CONFIG.confidenceThreshold,
      },
    });

    const result = await engine.distill(batch);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.facts).toHaveLength(2);
    expect(result.value.facts[0].content).toBe("fact-1");
    expect(result.value.facts[1].content).toBe("fact-2");
    expect(result.value.failedCandidateIds).toEqual(["c-3"]);
  });
});
