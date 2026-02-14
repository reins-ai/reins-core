import { describe, expect, it } from "bun:test";

import {
  MEMORY_LAYERS,
  MEMORY_TYPES,
  isValidMemoryLayer,
  isValidMemoryType,
  validateMemoryRecord,
  type MemoryRecord,
} from "../../../src/memory/types/index";

function createValidRecord(): MemoryRecord {
  const now = new Date("2026-02-13T12:00:00.000Z");

  return {
    id: "0194f56f-4e7f-7d7d-a8f3-2f6055fd8b62",
    content: "User prefers concise release notes.",
    type: "preference",
    layer: "stm",
    tags: ["writing", "style"],
    entities: ["release-notes"],
    importance: 0.72,
    confidence: 0.86,
    provenance: {
      sourceType: "implicit",
      conversationId: "conv_123",
    },
    supersedes: "0194f56f-4e7f-7d7d-a8f3-2f6055fd8b61",
    supersededBy: "0194f56f-4e7f-7d7d-a8f3-2f6055fd8b63",
    embedding: {
      provider: "openai",
      model: "text-embedding-3-small",
      dimension: 1536,
      version: "2026-02-13",
    },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
  };
}

describe("memory taxonomy", () => {
  it("defines the full memory type taxonomy", () => {
    expect(MEMORY_TYPES).toEqual([
      "fact",
      "preference",
      "decision",
      "episode",
      "skill",
      "entity",
      "document_chunk",
    ]);
  });

  it("defines working, stm, and ltm memory layers", () => {
    expect(MEMORY_LAYERS).toEqual(["working", "stm", "ltm"]);
  });

  it("validates known and unknown memory types", () => {
    expect(isValidMemoryType("fact")).toBe(true);
    expect(isValidMemoryType("document_chunk")).toBe(true);
    expect(isValidMemoryType("context")).toBe(false);
    expect(isValidMemoryType("")).toBe(false);
  });

  it("validates known and unknown memory layers", () => {
    expect(isValidMemoryLayer("working")).toBe(true);
    expect(isValidMemoryLayer("stm")).toBe(true);
    expect(isValidMemoryLayer("ltm")).toBe(true);
    expect(isValidMemoryLayer("archive")).toBe(false);
  });
});

describe("validateMemoryRecord", () => {
  it("accepts a valid STM memory record", () => {
    const result = validateMemoryRecord(createValidRecord());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.layer).toBe("stm");
      expect(result.value.type).toBe("preference");
    }
  });

  it("rejects working-memory records for persisted validation", () => {
    const candidate = {
      ...createValidRecord(),
      layer: "working",
    };

    const result = validateMemoryRecord(candidate);
    expect(result.ok).toBe(false);
  });

  it("rejects records with unknown taxonomy type", () => {
    const candidate = {
      ...createValidRecord(),
      type: "note",
    };

    const result = validateMemoryRecord(candidate);
    expect(result.ok).toBe(false);
  });

  it("rejects out-of-range scores", () => {
    const highImportance = {
      ...createValidRecord(),
      importance: 1.2,
    };

    const lowConfidence = {
      ...createValidRecord(),
      confidence: -0.2,
    };

    expect(validateMemoryRecord(highImportance).ok).toBe(false);
    expect(validateMemoryRecord(lowConfidence).ok).toBe(false);
  });

  it("rejects malformed provenance", () => {
    const missingSourceType = {
      ...createValidRecord(),
      provenance: {
        conversationId: "conv_123",
      },
    };

    const invalidSourceType = {
      ...createValidRecord(),
      provenance: {
        sourceType: "sync",
      },
    };

    expect(validateMemoryRecord(missingSourceType).ok).toBe(false);
    expect(validateMemoryRecord(invalidSourceType).ok).toBe(false);
  });

  it("rejects invalid timestamps", () => {
    const candidate = {
      ...createValidRecord(),
      accessedAt: "2026-02-13T12:00:00.000Z",
    };

    const result = validateMemoryRecord(candidate);
    expect(result.ok).toBe(false);
  });

  it("rejects invalid embedding metadata", () => {
    const candidate = {
      ...createValidRecord(),
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimension: 0,
        version: "2026-02-13",
      },
    };

    const result = validateMemoryRecord(candidate);
    expect(result.ok).toBe(false);
  });

  it("rejects non-string tags and entities", () => {
    const badTags = {
      ...createValidRecord(),
      tags: ["valid", 42],
    };

    const badEntities = {
      ...createValidRecord(),
      entities: ["valid", false],
    };

    expect(validateMemoryRecord(badTags).ok).toBe(false);
    expect(validateMemoryRecord(badEntities).ok).toBe(false);
  });
});
