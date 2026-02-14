import { describe, expect, it } from "bun:test";
import {
  validateProvenance,
  ProvenanceValidationError,
  type ProvenanceRecord,
} from "../../../src/memory/types/provenance";
import {
  MemoryProvenanceRepository,
  ProvenanceRepositoryError,
} from "../../../src/memory/storage/memory-provenance-repository";

function makeValidProvenance(overrides?: Partial<ProvenanceRecord>): ProvenanceRecord {
  return {
    source: "implicit",
    conversationId: "conv-001",
    sessionId: "session-001",
    messageIds: ["msg-1", "msg-2"],
    extractionEvent: "session_end",
    extractedAt: "2026-02-13T10:00:00.000Z",
    confidence: 0.85,
    extractionVersion: "session-extractor-v1",
    ...overrides,
  };
}

describe("ProvenanceRecord validation", () => {
  it("accepts a fully populated valid provenance record", () => {
    const record = makeValidProvenance();
    const result = validateProvenance(record);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.source).toBe("implicit");
      expect(result.value.conversationId).toBe("conv-001");
      expect(result.value.sessionId).toBe("session-001");
      expect(result.value.messageIds).toEqual(["msg-1", "msg-2"]);
      expect(result.value.extractionEvent).toBe("session_end");
      expect(result.value.confidence).toBe(0.85);
      expect(result.value.extractionVersion).toBe("session-extractor-v1");
    }
  });

  it("accepts a minimal provenance record with only required fields", () => {
    const record: ProvenanceRecord = {
      source: "explicit",
      extractedAt: "2026-02-13T10:00:00.000Z",
      extractionVersion: "v1",
    };
    const result = validateProvenance(record);
    expect(result.ok).toBe(true);
  });

  it("accepts all valid source types", () => {
    const sourceTypes = ["explicit", "implicit", "compaction", "consolidation", "document"] as const;
    for (const source of sourceTypes) {
      const result = validateProvenance(makeValidProvenance({ source }));
      expect(result.ok).toBe(true);
    }
  });

  it("accepts all valid extraction events", () => {
    const events = ["session_end", "compaction", "manual", "file_ingestion", "consolidation"] as const;
    for (const extractionEvent of events) {
      const result = validateProvenance(makeValidProvenance({ extractionEvent }));
      expect(result.ok).toBe(true);
    }
  });

  it("rejects missing source", () => {
    const record = makeValidProvenance({ source: "" as never });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(ProvenanceValidationError);
      expect(result.error.message).toContain("source");
    }
  });

  it("rejects missing extractedAt", () => {
    const record = makeValidProvenance({ extractedAt: "" });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("extractedAt");
    }
  });

  it("rejects non-ISO extractedAt", () => {
    const record = makeValidProvenance({ extractedAt: "not-a-date" });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ISO 8601");
    }
  });

  it("rejects missing extractionVersion", () => {
    const record = makeValidProvenance({ extractionVersion: "" });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("extractionVersion");
    }
  });

  it("rejects whitespace-only extractionVersion", () => {
    const record = makeValidProvenance({ extractionVersion: "   " });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("extractionVersion");
    }
  });

  it("rejects empty conversationId when provided", () => {
    const record = makeValidProvenance({ conversationId: "" });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("conversationId");
    }
  });

  it("rejects empty sessionId when provided", () => {
    const record = makeValidProvenance({ sessionId: "  " });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("sessionId");
    }
  });

  it("rejects non-array messageIds", () => {
    const record = makeValidProvenance({ messageIds: "msg-1" as never });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("messageIds");
    }
  });

  it("rejects empty string in messageIds array", () => {
    const record = makeValidProvenance({ messageIds: ["msg-1", ""] });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("messageIds[1]");
    }
  });

  it("rejects invalid extractionEvent", () => {
    const record = makeValidProvenance({ extractionEvent: "invalid" as never });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("extractionEvent");
    }
  });

  it("rejects confidence below 0", () => {
    const record = makeValidProvenance({ confidence: -0.1 });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("confidence");
    }
  });

  it("rejects confidence above 1", () => {
    const record = makeValidProvenance({ confidence: 1.5 });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("confidence");
    }
  });

  it("rejects NaN confidence", () => {
    const record = makeValidProvenance({ confidence: NaN });
    const result = validateProvenance(record);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("confidence");
    }
  });

  it("accepts confidence at boundary values 0 and 1", () => {
    expect(validateProvenance(makeValidProvenance({ confidence: 0 })).ok).toBe(true);
    expect(validateProvenance(makeValidProvenance({ confidence: 1 })).ok).toBe(true);
  });
});

describe("MemoryProvenanceRepository", () => {
  function createRepo() {
    const fixedDate = new Date("2026-02-13T12:00:00.000Z");
    return new MemoryProvenanceRepository({ now: () => fixedDate });
  }

  describe("saveProvenance", () => {
    it("saves and retrieves a valid provenance record", async () => {
      const repo = createRepo();
      const provenance = makeValidProvenance();

      const saveResult = await repo.saveProvenance("mem-001", provenance);
      expect(saveResult.ok).toBe(true);

      const getResult = await repo.getProvenance("mem-001");
      expect(getResult.ok).toBe(true);
      if (getResult.ok) {
        expect(getResult.value).not.toBeNull();
        expect(getResult.value!.source).toBe("implicit");
        expect(getResult.value!.conversationId).toBe("conv-001");
        expect(getResult.value!.sessionId).toBe("session-001");
        expect(getResult.value!.extractionVersion).toBe("session-extractor-v1");
      }
    });

    it("overwrites existing provenance for the same memory id", async () => {
      const repo = createRepo();

      await repo.saveProvenance("mem-001", makeValidProvenance({ confidence: 0.5 }));
      await repo.saveProvenance("mem-001", makeValidProvenance({ confidence: 0.9 }));

      const result = await repo.getProvenance("mem-001");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value!.confidence).toBe(0.9);
      }
    });

    it("rejects empty memoryId", async () => {
      const repo = createRepo();
      const result = await repo.saveProvenance("", makeValidProvenance());
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ProvenanceRepositoryError);
        expect(result.error.message).toContain("memoryId");
      }
    });

    it("rejects invalid provenance record", async () => {
      const repo = createRepo();
      const invalid = makeValidProvenance({ extractedAt: "bad-date" });
      const result = await repo.saveProvenance("mem-001", invalid);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(ProvenanceRepositoryError);
        expect(result.error.code).toBe("PROVENANCE_REPOSITORY_VALIDATION_ERROR");
      }
    });
  });

  describe("getProvenance", () => {
    it("returns null for non-existent memory id", async () => {
      const repo = createRepo();
      const result = await repo.getProvenance("non-existent");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it("rejects empty memoryId", async () => {
      const repo = createRepo();
      const result = await repo.getProvenance("  ");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("memoryId");
      }
    });
  });

  describe("findByFilter", () => {
    async function seedRepo() {
      const repo = createRepo();

      await repo.saveProvenance("mem-001", makeValidProvenance({
        source: "implicit",
        conversationId: "conv-A",
        extractionEvent: "session_end",
        extractedAt: "2026-02-13T10:00:00.000Z",
      }));

      await repo.saveProvenance("mem-002", makeValidProvenance({
        source: "compaction",
        conversationId: "conv-A",
        extractionEvent: "compaction",
        extractedAt: "2026-02-13T11:00:00.000Z",
      }));

      await repo.saveProvenance("mem-003", makeValidProvenance({
        source: "implicit",
        conversationId: "conv-B",
        extractionEvent: "session_end",
        extractedAt: "2026-02-14T09:00:00.000Z",
      }));

      await repo.saveProvenance("mem-004", makeValidProvenance({
        source: "explicit",
        conversationId: "conv-C",
        extractionEvent: "manual",
        extractedAt: "2026-02-15T08:00:00.000Z",
      }));

      return repo;
    }

    it("filters by single source type", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({ source: "implicit" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(["mem-001", "mem-003"]);
      }
    });

    it("filters by multiple source types", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({ source: ["implicit", "compaction"] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sort()).toEqual(["mem-001", "mem-002", "mem-003"]);
      }
    });

    it("filters by conversation id", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({ conversationId: "conv-A" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sort()).toEqual(["mem-001", "mem-002"]);
      }
    });

    it("filters by extraction event", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({ extractionEvent: "session_end" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sort()).toEqual(["mem-001", "mem-003"]);
      }
    });

    it("filters by date range (after)", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({ after: "2026-02-14T00:00:00.000Z" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sort()).toEqual(["mem-003", "mem-004"]);
      }
    });

    it("filters by date range (before)", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({ before: "2026-02-13T11:00:00.000Z" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(["mem-001"]);
      }
    });

    it("filters by date range (after and before)", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({
        after: "2026-02-13T10:30:00.000Z",
        before: "2026-02-14T10:00:00.000Z",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sort()).toEqual(["mem-002", "mem-003"]);
      }
    });

    it("combines multiple filter criteria", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({
        source: "implicit",
        extractionEvent: "session_end",
        after: "2026-02-14T00:00:00.000Z",
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(["mem-003"]);
      }
    });

    it("returns empty array when no records match", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({ source: "document" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("returns all records with empty filter", async () => {
      const repo = await seedRepo();
      const result = await repo.findByFilter({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(4);
      }
    });
  });

  describe("findByConversation", () => {
    it("returns memory ids for a given conversation", async () => {
      const repo = createRepo();

      await repo.saveProvenance("mem-001", makeValidProvenance({ conversationId: "conv-X" }));
      await repo.saveProvenance("mem-002", makeValidProvenance({ conversationId: "conv-X" }));
      await repo.saveProvenance("mem-003", makeValidProvenance({ conversationId: "conv-Y" }));

      const result = await repo.findByConversation("conv-X");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sort()).toEqual(["mem-001", "mem-002"]);
      }
    });

    it("returns empty array for unknown conversation", async () => {
      const repo = createRepo();
      const result = await repo.findByConversation("unknown");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it("rejects empty conversationId", async () => {
      const repo = createRepo();
      const result = await repo.findByConversation("");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("conversationId");
      }
    });
  });

  describe("findBySource", () => {
    it("returns memory ids for a given source type", async () => {
      const repo = createRepo();

      await repo.saveProvenance("mem-001", makeValidProvenance({ source: "compaction" }));
      await repo.saveProvenance("mem-002", makeValidProvenance({ source: "implicit" }));
      await repo.saveProvenance("mem-003", makeValidProvenance({ source: "compaction" }));

      const result = await repo.findBySource("compaction");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.sort()).toEqual(["mem-001", "mem-003"]);
      }
    });

    it("returns empty array for source type with no records", async () => {
      const repo = createRepo();
      const result = await repo.findBySource("document");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });
  });

  describe("empty repository", () => {
    it("returns empty results from all query methods", async () => {
      const repo = createRepo();

      const byFilter = await repo.findByFilter({ source: "implicit" });
      expect(byFilter.ok).toBe(true);
      if (byFilter.ok) {
        expect(byFilter.value).toEqual([]);
      }

      const byConv = await repo.findByConversation("any");
      expect(byConv.ok).toBe(true);
      if (byConv.ok) {
        expect(byConv.value).toEqual([]);
      }

      const bySource = await repo.findBySource("explicit");
      expect(bySource.ok).toBe(true);
      if (bySource.ok) {
        expect(bySource.value).toEqual([]);
      }
    });
  });
});
