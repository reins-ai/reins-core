import { describe, expect, it } from "bun:test";
import { ImportanceScorer } from "../../../src/memory/consolidation/importance-scorer";
import {
  PatternDetector,
  type DetectedPattern,
  type PatternMemoryLookup,
} from "../../../src/memory/proactive/pattern-detector";
import type { MemoryRecord } from "../../../src/memory/types/index";

const NOW = new Date("2026-02-13T10:00:00.000Z");

function createMemory(options: {
  id: string;
  content: string;
  createdAtMs: number;
  type?: MemoryRecord["type"];
  tags?: string[];
  entities?: string[];
}): MemoryRecord {
  const timestamp = new Date(options.createdAtMs);
  return {
    id: options.id,
    content: options.content,
    type: options.type ?? "fact",
    layer: "ltm",
    tags: options.tags ?? [],
    entities: options.entities ?? [],
    importance: 0.5,
    confidence: 0.6,
    provenance: { sourceType: "implicit", conversationId: `conv-${options.id}` },
    createdAt: timestamp,
    updatedAt: timestamp,
    accessedAt: timestamp,
  };
}

function createDetector(overrides?: {
  lookup?: PatternMemoryLookup;
  config?: {
    minOccurrences?: number;
    windowMs?: number;
    confidenceThreshold?: number;
    decayRate?: number;
    promotionThreshold?: number;
  };
}) {
  let sequence = 0;
  return new PatternDetector({
    lookup: overrides?.lookup ?? {},
    scorer: new ImportanceScorer(),
    config: {
      minOccurrences: 3,
      windowMs: 14 * 24 * 60 * 60 * 1000,
      confidenceThreshold: 0.4,
      decayRate: 0.2,
      promotionThreshold: 0.7,
      ...overrides?.config,
    },
    now: () => NOW,
    generateId: () => `id-${++sequence}`,
  });
}

describe("PatternDetector", () => {
  it("detects a recurring pattern from memory history with 3+ occurrences", () => {
    const detector = createDetector();
    const history = [
      createMemory({
        id: "m-1",
        content: "Please keep responses concise",
        type: "preference",
        tags: ["style"],
        createdAtMs: NOW.getTime() - 5 * 24 * 60 * 60 * 1000,
      }),
      createMemory({
        id: "m-2",
        content: "I prefer concise answers",
        type: "preference",
        tags: ["style"],
        createdAtMs: NOW.getTime() - 4 * 24 * 60 * 60 * 1000,
      }),
      createMemory({
        id: "m-3",
        content: "Keep replies short",
        type: "preference",
        tags: ["style"],
        createdAtMs: NOW.getTime() - 2 * 24 * 60 * 60 * 1000,
      }),
    ];

    const result = detector.detectPatterns(history);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.length).toBe(1);
    expect(result.value[0].occurrences).toBe(3);
    expect(result.value[0].patternType).toBe("preference");
    expect(result.value[0].sourceMemoryIds).toEqual(["m-1", "m-2", "m-3"]);
  });

  it("does not detect patterns below minimum occurrence threshold", () => {
    const detector = createDetector();
    const history = [
      createMemory({
        id: "m-1",
        content: "Use markdown bullets",
        createdAtMs: NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
      }),
      createMemory({
        id: "m-2",
        content: "Use markdown bullets",
        createdAtMs: NOW.getTime() - 2 * 24 * 60 * 60 * 1000,
      }),
    ];

    const result = detector.detectPatterns(history);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it("assigns higher confidence to more frequent and recent consistent patterns", () => {
    const detector = createDetector({
      config: {
        confidenceThreshold: 0.2,
      },
    });

    const history = [
      createMemory({
        id: "a-1",
        content: "Daily summary every morning",
        tags: ["briefing"],
        createdAtMs: NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
      }),
      createMemory({
        id: "a-2",
        content: "Every morning show me a summary",
        tags: ["briefing"],
        createdAtMs: NOW.getTime() - 2 * 24 * 60 * 60 * 1000,
      }),
      createMemory({
        id: "a-3",
        content: "Morning daily summary please",
        tags: ["briefing"],
        createdAtMs: NOW.getTime() - 1 * 24 * 60 * 60 * 1000,
      }),
      createMemory({
        id: "a-4",
        content: "Need my morning summary",
        tags: ["briefing"],
        createdAtMs: NOW.getTime() - 12 * 60 * 60 * 1000,
      }),
      createMemory({
        id: "b-1",
        content: "Discuss travel ideas",
        tags: ["travel"],
        createdAtMs: NOW.getTime() - 10 * 24 * 60 * 60 * 1000,
      }),
      createMemory({
        id: "b-2",
        content: "Travel destinations to consider",
        tags: ["travel"],
        createdAtMs: NOW.getTime() - 9 * 24 * 60 * 60 * 1000,
      }),
      createMemory({
        id: "b-3",
        content: "Travel suggestions",
        tags: ["travel"],
        createdAtMs: NOW.getTime() - 8 * 24 * 60 * 60 * 1000,
      }),
    ];

    const result = detector.detectPatterns(history);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBeGreaterThanOrEqual(2);
    expect(result.value[0].confidence).toBeGreaterThan(result.value[1].confidence);
    expect(result.value[0].confidence).toBeLessThanOrEqual(1);
  });

  it("enforces time window and excludes old occurrences", () => {
    const detector = createDetector({
      config: {
        windowMs: 7 * 24 * 60 * 60 * 1000,
      },
    });

    const history = [
      createMemory({ id: "m-1", content: "Prefers short responses", createdAtMs: NOW.getTime() - 2 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "m-2", content: "Prefers short responses", createdAtMs: NOW.getTime() - 1 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "m-3", content: "Prefers short responses", createdAtMs: NOW.getTime() - 12 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "m-4", content: "Prefers short responses", createdAtMs: NOW.getTime() - 13 * 24 * 60 * 60 * 1000 }),
    ];

    const result = detector.detectPatterns(history);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(0);
  });

  it("promotes a stable pattern to preference memory", () => {
    const detector = createDetector();
    const pattern: DetectedPattern = {
      id: "pattern-1",
      content: "concise response style",
      occurrences: 4,
      firstSeen: NOW.getTime() - 5 * 24 * 60 * 60 * 1000,
      lastSeen: NOW.getTime() - 1 * 24 * 60 * 60 * 1000,
      confidence: 0.82,
      sourceMemoryIds: ["m-1", "m-2", "m-3", "m-4"],
      patternType: "preference",
    };

    const promotion = detector.promoteToPreference(pattern);

    expect(promotion.promotedMemory.type).toBe("preference");
    expect(promotion.promotedMemory.layer).toBe("ltm");
    expect(promotion.promotedMemory.provenance.sourceType).toBe("implicit");
    expect(promotion.promotedMemory.content).toContain("user prefers");
  });

  it("preserves evidence chain when promoting pattern", () => {
    const detector = createDetector();
    const pattern: DetectedPattern = {
      id: "pattern-1",
      content: "morning briefing preference",
      occurrences: 3,
      firstSeen: NOW.getTime() - 3 * 24 * 60 * 60 * 1000,
      lastSeen: NOW.getTime() - 1 * 24 * 60 * 60 * 1000,
      confidence: 0.78,
      sourceMemoryIds: ["a", "b", "c"],
      patternType: "temporal",
    };

    const promotion = detector.promoteToPreference(pattern);

    expect(promotion.evidenceChain).toEqual(["a", "b", "c"]);
    expect(promotion.promotedMemory.provenance.conversationId).toBe("a,b,c");
  });

  it("decays pattern confidence over time", () => {
    const detector = createDetector({
      config: {
        windowMs: 7 * 24 * 60 * 60 * 1000,
        confidenceThreshold: 0.1,
        decayRate: 0.25,
      },
    });

    const pattern: DetectedPattern = {
      id: "pattern-1",
      content: "prefers concise answers",
      occurrences: 3,
      firstSeen: NOW.getTime() - 14 * 24 * 60 * 60 * 1000,
      lastSeen: NOW.getTime() - 10 * 24 * 60 * 60 * 1000,
      confidence: 0.9,
      sourceMemoryIds: ["m-1", "m-2", "m-3"],
      patternType: "preference",
    };

    const decayed = detector.decayPatterns([pattern], NOW.getTime());

    expect(decayed).toHaveLength(1);
    expect(decayed[0].confidence).toBeLessThan(pattern.confidence);
  });

  it("removes patterns that decay below confidence threshold", () => {
    const detector = createDetector({
      config: {
        windowMs: 7 * 24 * 60 * 60 * 1000,
        confidenceThreshold: 0.4,
        decayRate: 0.3,
      },
    });

    const pattern: DetectedPattern = {
      id: "pattern-1",
      content: "weekly report check",
      occurrences: 3,
      firstSeen: NOW.getTime() - 30 * 24 * 60 * 60 * 1000,
      lastSeen: NOW.getTime() - 28 * 24 * 60 * 60 * 1000,
      confidence: 0.45,
      sourceMemoryIds: ["x", "y", "z"],
      patternType: "temporal",
    };

    const decayed = detector.decayPatterns([pattern], NOW.getTime());

    expect(decayed).toHaveLength(0);
  });

  it("detects multiple patterns from mixed history", () => {
    const detector = createDetector({
      config: { confidenceThreshold: 0.2 },
    });
    const history = [
      createMemory({ id: "c1", content: "Use concise answers", tags: ["style"], createdAtMs: NOW.getTime() - 4 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "c2", content: "Keep answers concise", tags: ["style"], createdAtMs: NOW.getTime() - 3 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "c3", content: "Concise response format", tags: ["style"], createdAtMs: NOW.getTime() - 2 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "d1", content: "Morning summary every day", tags: ["briefing"], createdAtMs: NOW.getTime() - 5 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "d2", content: "Daily morning briefing", tags: ["briefing"], createdAtMs: NOW.getTime() - 3 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "d3", content: "Morning briefing reminder", tags: ["briefing"], createdAtMs: NOW.getTime() - 1 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "noise", content: "Book restaurant next week", tags: ["todo"], createdAtMs: NOW.getTime() - 1 * 24 * 60 * 60 * 1000 }),
    ];

    const result = detector.detectPatterns(history);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    expect(result.value[0].occurrences).toBeGreaterThanOrEqual(3);
    expect(result.value[1].occurrences).toBeGreaterThanOrEqual(3);
  });

  it("returns no patterns for empty history", () => {
    const detector = createDetector();
    const result = detector.detectPatterns([]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });

  it("groups content case-insensitively through normalization", () => {
    const detector = createDetector();
    const history = [
      createMemory({ id: "m1", content: "PREFERS CONCISE ANSWERS!", createdAtMs: NOW.getTime() - 3 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "m2", content: "prefers concise answers", createdAtMs: NOW.getTime() - 2 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "m3", content: "Prefers concise answers.", createdAtMs: NOW.getTime() - 1 * 24 * 60 * 60 * 1000 }),
    ];

    const result = detector.detectPatterns(history);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].occurrences).toBe(3);
  });

  it("includes lookup-provided history in detection", () => {
    const lookupHistory = [
      createMemory({ id: "l1", content: "User likes short replies", tags: ["style"], createdAtMs: NOW.getTime() - 4 * 24 * 60 * 60 * 1000 }),
      createMemory({ id: "l2", content: "User likes short replies", tags: ["style"], createdAtMs: NOW.getTime() - 2 * 24 * 60 * 60 * 1000 }),
    ];

    const detector = createDetector({
      lookup: {
        listRecentMemories: () => lookupHistory,
      },
      config: {
        minOccurrences: 2,
      },
    });

    const result = detector.detectPatterns([]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0].sourceMemoryIds).toEqual(["l1", "l2"]);
  });
});
