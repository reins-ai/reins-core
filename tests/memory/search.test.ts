import { describe, expect, test } from "bun:test";

import { searchMemories } from "../../src/memory/search";
import type { MemoryEntry } from "../../src/memory/types";

function createEntry(overrides?: Partial<MemoryEntry>): MemoryEntry {
  const now = new Date();

  return {
    id: overrides?.id ?? crypto.randomUUID(),
    content: overrides?.content ?? "Default memory",
    type: overrides?.type ?? "note",
    tags: overrides?.tags ?? ["general"],
    importance: overrides?.importance ?? 0.5,
    conversationId: overrides?.conversationId,
    createdAt: overrides?.createdAt ?? now,
    updatedAt: overrides?.updatedAt ?? now,
    expiresAt: overrides?.expiresAt,
  };
}

describe("searchMemories", () => {
  test("ranks exact text matches above partial matches", () => {
    const updatedAt = new Date("2026-02-01T00:00:00.000Z");
    const entries: MemoryEntry[] = [
      createEntry({
        id: "exact",
        content: "java",
        importance: 0.5,
        updatedAt,
      }),
      createEntry({
        id: "partial",
        content: "i like java programming",
        importance: 0.5,
        updatedAt,
      }),
    ];

    const results = searchMemories(entries, { query: "java" });
    expect(results.map((result) => result.entry.id)).toEqual(["exact", "partial"]);
    expect((results[0]?.score ?? 0) > (results[1]?.score ?? 0)).toBe(true);
  });

  test("applies recency boost when text and importance are equal", () => {
    const recent = new Date(Date.now() - 60_000);
    const stale = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const entries: MemoryEntry[] = [
      createEntry({
        id: "old",
        content: "project codename aurora",
        importance: 0.6,
        updatedAt: stale,
      }),
      createEntry({
        id: "new",
        content: "project codename aurora",
        importance: 0.6,
        updatedAt: recent,
      }),
    ];

    const results = searchMemories(entries, { query: "aurora" });
    expect(results[0]?.entry.id).toBe("new");
    expect((results[0]?.score ?? 0) > (results[1]?.score ?? 0)).toBe(true);
  });

  test("weights importance when text relevance is equal", () => {
    const updatedAt = new Date(Date.now() - 60_000);
    const entries: MemoryEntry[] = [
      createEntry({
        id: "high",
        content: "release window is friday",
        importance: 0.95,
        updatedAt,
      }),
      createEntry({
        id: "low",
        content: "release window is friday",
        importance: 0.2,
        updatedAt,
      }),
    ];

    const results = searchMemories(entries, { query: "release" });
    expect(results[0]?.entry.id).toBe("high");
    expect((results[0]?.score ?? 0) > (results[1]?.score ?? 0)).toBe(true);
  });
});
