import { describe, expect, it } from "bun:test";

import type { MemoryRecord } from "../../../src/memory/types";
import { getStaleMemories, isStale } from "../../../src/memory/services/stale-detection";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * MS_PER_DAY);
}

function daysFromNow(days: number): Date {
  return new Date(Date.now() + days * MS_PER_DAY);
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? "mem-1",
    content: overrides.content ?? "test memory content",
    type: overrides.type ?? "fact",
    layer: overrides.layer ?? "ltm",
    tags: overrides.tags ?? [],
    entities: overrides.entities ?? [],
    importance: overrides.importance ?? 0.5,
    confidence: overrides.confidence ?? 0.8,
    provenance: overrides.provenance ?? { sourceType: "explicit" },
    createdAt: overrides.createdAt ?? new Date(),
    updatedAt: overrides.updatedAt ?? new Date(),
    accessedAt: overrides.accessedAt ?? new Date(),
  };
}

describe("isStale", () => {
  it("returns true for a record accessed 91 days ago", () => {
    const record = makeRecord({ accessedAt: daysAgo(91) });

    expect(isStale(record)).toBe(true);
  });

  it("returns false for a record accessed 89 days ago", () => {
    const record = makeRecord({ accessedAt: daysAgo(89) });

    expect(isStale(record)).toBe(false);
  });

  it("returns true for a record accessed exactly 90 days ago (inclusive threshold)", () => {
    const record = makeRecord({ accessedAt: daysAgo(90) });

    expect(isStale(record)).toBe(true);
  });

  it("returns false for a record accessed today", () => {
    const record = makeRecord({ accessedAt: new Date() });

    expect(isStale(record)).toBe(false);
  });

  it("respects a custom threshold of 30 days", () => {
    const staleRecord = makeRecord({ accessedAt: daysAgo(31) });
    const freshRecord = makeRecord({ accessedAt: daysAgo(29) });

    expect(isStale(staleRecord, 30)).toBe(true);
    expect(isStale(freshRecord, 30)).toBe(false);
  });

  it("returns false for a record with a future accessedAt date", () => {
    const record = makeRecord({ accessedAt: daysFromNow(10) });

    expect(isStale(record)).toBe(false);
  });
});

describe("getStaleMemories", () => {
  it("returns an empty array for empty input", () => {
    const result = getStaleMemories([]);

    expect(result).toEqual([]);
  });

  it("returns only stale records from a mixed array", () => {
    const stale1 = makeRecord({ id: "stale-1", accessedAt: daysAgo(100) });
    const fresh1 = makeRecord({ id: "fresh-1", accessedAt: daysAgo(10) });
    const stale2 = makeRecord({ id: "stale-2", accessedAt: daysAgo(91) });
    const fresh2 = makeRecord({ id: "fresh-2", accessedAt: new Date() });

    const result = getStaleMemories([stale1, fresh1, stale2, fresh2]);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("stale-1");
    expect(result[1].id).toBe("stale-2");
  });

  it("returns an empty array when all records are fresh", () => {
    const records = [
      makeRecord({ id: "a", accessedAt: daysAgo(1) }),
      makeRecord({ id: "b", accessedAt: daysAgo(30) }),
      makeRecord({ id: "c", accessedAt: new Date() }),
    ];

    const result = getStaleMemories(records);

    expect(result).toEqual([]);
  });

  it("returns all records when all are stale", () => {
    const records = [
      makeRecord({ id: "a", accessedAt: daysAgo(91) }),
      makeRecord({ id: "b", accessedAt: daysAgo(180) }),
      makeRecord({ id: "c", accessedAt: daysAgo(365) }),
    ];

    const result = getStaleMemories(records);

    expect(result).toHaveLength(3);
  });

  it("preserves original array order", () => {
    const records = [
      makeRecord({ id: "z-stale", accessedAt: daysAgo(200) }),
      makeRecord({ id: "fresh", accessedAt: new Date() }),
      makeRecord({ id: "a-stale", accessedAt: daysAgo(100) }),
    ];

    const result = getStaleMemories(records);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("z-stale");
    expect(result[1].id).toBe("a-stale");
  });

  it("does not mutate the input array", () => {
    const records = [
      makeRecord({ id: "stale", accessedAt: daysAgo(100) }),
      makeRecord({ id: "fresh", accessedAt: new Date() }),
    ];
    const originalLength = records.length;

    getStaleMemories(records);

    expect(records).toHaveLength(originalLength);
    expect(records[0].id).toBe("stale");
    expect(records[1].id).toBe("fresh");
  });
});
