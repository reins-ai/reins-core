import { describe, expect, it } from "bun:test";

import { ok, err, type Result } from "../../../src/result";
import { ReinsError } from "../../../src/errors";
import type { MemoryRecord } from "../../../src/memory/types/index";
import {
  StmSelector,
  ConsolidationError,
  type StmRecordSource,
} from "../../../src/memory/consolidation/stm-selector";
import {
  DEFAULT_BATCH_CONFIG,
  type BatchConfig,
} from "../../../src/memory/consolidation/stm-queue";

function makeRecord(overrides: Partial<MemoryRecord> & { id: string }): MemoryRecord {
  const now = new Date("2026-01-15T12:00:00Z");
  return {
    content: `Memory content for ${overrides.id}`,
    type: "fact",
    layer: "stm",
    tags: [],
    entities: [],
    importance: 0.5,
    confidence: 0.8,
    provenance: { sourceType: "implicit" },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    ...overrides,
  };
}

function makeSource(records: MemoryRecord[]): StmRecordSource {
  return {
    listStmRecords: async () => ok(records),
  };
}

function makeFailingSource(message: string): StmRecordSource {
  return {
    listStmRecords: async () => err(new ReinsError(message, "TEST_ERROR")),
  };
}

function makeSelector(
  records: MemoryRecord[],
  config?: Partial<BatchConfig>,
  now?: () => Date,
  generateId?: () => string,
): StmSelector {
  return new StmSelector({
    source: makeSource(records),
    config,
    now,
    generateId,
  });
}

let idCounter = 0;
function sequentialId(): string {
  idCounter += 1;
  return `batch-${idCounter}`;
}

describe("StmSelector", () => {
  describe("selectBatch", () => {
    it("selects STM-layer records that meet minimum age", async () => {
      const now = new Date("2026-01-15T12:30:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({ id: "r2", createdAt: new Date("2026-01-15T12:10:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 10 * 60 * 1000 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidates).toHaveLength(2);
      expect(result.value.candidates[0].record.id).toBe("r1");
      expect(result.value.candidates[1].record.id).toBe("r2");
    });

    it("filters out records below minimum age threshold", async () => {
      const now = new Date("2026-01-15T12:06:00Z");
      const records = [
        makeRecord({ id: "old", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({ id: "young", createdAt: new Date("2026-01-15T12:05:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 5 * 60 * 1000 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidates).toHaveLength(1);
      expect(result.value.candidates[0].record.id).toBe("old");
    });

    it("filters out non-STM layer records", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "stm-1", layer: "stm", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({ id: "ltm-1", layer: "ltm", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidates).toHaveLength(1);
      expect(result.value.candidates[0].record.id).toBe("stm-1");
    });

    it("filters out superseded records", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "active", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({
          id: "superseded",
          supersededBy: "some-other-id",
          createdAt: new Date("2026-01-15T12:00:00Z"),
        }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidates).toHaveLength(1);
      expect(result.value.candidates[0].record.id).toBe("active");
    });

    it("enforces batch size limit", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = Array.from({ length: 10 }, (_, i) =>
        makeRecord({
          id: `r${i}`,
          createdAt: new Date(`2026-01-15T12:0${i}:00Z`),
        }),
      );

      const selector = makeSelector(records, { batchSize: 3, minAgeMs: 0 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidates).toHaveLength(3);
    });

    it("orders deterministically by createdAt ascending then by id", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const sameTime = new Date("2026-01-15T12:00:00Z");
      const records = [
        makeRecord({ id: "charlie", createdAt: sameTime }),
        makeRecord({ id: "alpha", createdAt: sameTime }),
        makeRecord({ id: "bravo", createdAt: sameTime }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const ids = result.value.candidates.map((c) => c.record.id);
      expect(ids).toEqual(["alpha", "bravo", "charlie"]);
    });

    it("returns empty batch when no STM records exist", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const selector = makeSelector([], { minAgeMs: 0 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidates).toHaveLength(0);
      expect(result.value.batchId).toBeTruthy();
    });

    it("returns empty batch when all records are too young", async () => {
      const now = new Date("2026-01-15T12:01:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 10 * 60 * 1000 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidates).toHaveLength(0);
    });

    it("returns error when source fails", async () => {
      const selector = new StmSelector({
        source: makeFailingSource("db connection lost"),
        config: { minAgeMs: 0 },
      });

      const result = await selector.selectBatch();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(ConsolidationError);
      expect(result.error.code).toBe("CONSOLIDATION_SELECTION_FAILED");
    });

    it("assigns a unique batchId to each batch", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      let callCount = 0;
      const selector = makeSelector(
        records,
        { minAgeMs: 0 },
        () => now,
        () => `batch-${++callCount}`,
      );

      const result1 = await selector.selectBatch();
      expect(result1.ok).toBe(true);
      if (!result1.ok) return;
      expect(result1.value.batchId).toBe("batch-1");
    });

    it("sets all candidates to eligible status", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({ id: "r2", createdAt: new Date("2026-01-15T12:01:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      for (const candidate of result.value.candidates) {
        expect(candidate.status).toBe("eligible");
        expect(candidate.retryCount).toBe(0);
      }
    });

    it("sets batchId on each candidate", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(
        records,
        { minAgeMs: 0 },
        () => now,
        () => "fixed-batch-id",
      );
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidates[0].batchId).toBe("fixed-batch-id");
    });
  });

  describe("idempotent selection", () => {
    it("produces same candidates for same input when no state changes", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({ id: "r2", createdAt: new Date("2026-01-15T12:01:00Z") }),
      ];

      const source = makeSource(records);
      let batchNum = 0;
      const selector = new StmSelector({
        source,
        config: { minAgeMs: 0 },
        now: () => now,
        generateId: () => `batch-${++batchNum}`,
      });

      const result1 = await selector.selectBatch();
      expect(result1.ok).toBe(true);
      if (!result1.ok) return;

      // After first selection, candidates are tracked as eligible.
      // A second selectBatch should not re-select them because they are
      // now in the internal candidate map with eligible status (not terminal,
      // but they haven't been processed yet — they are still "eligible").
      // However, the selector filters out records that are in a terminal or
      // processing state. "eligible" is not terminal, so they would be
      // re-selected. This is correct behavior — idempotent means same
      // records appear if nothing has changed.
      const result2 = await selector.selectBatch();
      expect(result2.ok).toBe(true);
      if (!result2.ok) return;

      const ids1 = result1.value.candidates.map((c) => c.record.id);
      const ids2 = result2.value.candidates.map((c) => c.record.id);
      expect(ids1).toEqual(ids2);
    });

    it("excludes consolidated records from subsequent batches", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({ id: "r2", createdAt: new Date("2026-01-15T12:01:00Z") }),
      ];

      let batchNum = 0;
      const selector = new StmSelector({
        source: makeSource(records),
        config: { minAgeMs: 0 },
        now: () => now,
        generateId: () => `batch-${++batchNum}`,
      });

      const batch1 = await selector.selectBatch();
      expect(batch1.ok).toBe(true);
      if (!batch1.ok) return;

      selector.markProcessing(batch1.value.batchId, ["r1"]);
      selector.markConsolidated(["r1"]);

      const batch2 = await selector.selectBatch();
      expect(batch2.ok).toBe(true);
      if (!batch2.ok) return;

      const ids = batch2.value.candidates.map((c) => c.record.id);
      expect(ids).not.toContain("r1");
      expect(ids).toContain("r2");
    });
  });

  describe("deduplication window", () => {
    it("excludes recently consolidated records within dedupe window", async () => {
      let currentTime = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      let batchNum = 0;
      const selector = new StmSelector({
        source: makeSource(records),
        config: { minAgeMs: 0, dedupeWindowMs: 30 * 60 * 1000 },
        now: () => currentTime,
        generateId: () => `batch-${++batchNum}`,
      });

      // First batch: select and consolidate
      const batch1 = await selector.selectBatch();
      expect(batch1.ok).toBe(true);
      if (!batch1.ok) return;
      selector.markProcessing(batch1.value.batchId, ["r1"]);
      selector.markConsolidated(["r1"]);

      // Consolidated records are terminal — they won't be re-selected
      // regardless of dedupe window
      currentTime = new Date("2026-01-15T13:10:00Z");
      const batch2 = await selector.selectBatch();
      expect(batch2.ok).toBe(true);
      if (!batch2.ok) return;
      expect(batch2.value.candidates).toHaveLength(0);
    });

    it("excludes recently failed records within dedupe window", async () => {
      let currentTime = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      let batchNum = 0;
      const selector = new StmSelector({
        source: makeSource(records),
        config: { minAgeMs: 0, dedupeWindowMs: 30 * 60 * 1000, maxRetries: 3 },
        now: () => currentTime,
        generateId: () => `batch-${++batchNum}`,
      });

      // Select and fail
      const batch1 = await selector.selectBatch();
      expect(batch1.ok).toBe(true);
      if (!batch1.ok) return;
      selector.markProcessing(batch1.value.batchId, ["r1"]);
      selector.markFailed(["r1"]);

      // Within dedupe window — should be excluded
      currentTime = new Date("2026-01-15T13:10:00Z");
      const batch2 = await selector.selectBatch();
      expect(batch2.ok).toBe(true);
      if (!batch2.ok) return;
      expect(batch2.value.candidates).toHaveLength(0);
    });

    it("re-selects failed records after dedupe window expires", async () => {
      let currentTime = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      let batchNum = 0;
      const selector = new StmSelector({
        source: makeSource(records),
        config: { minAgeMs: 0, dedupeWindowMs: 30 * 60 * 1000, maxRetries: 3 },
        now: () => currentTime,
        generateId: () => `batch-${++batchNum}`,
      });

      // Select and fail
      const batch1 = await selector.selectBatch();
      expect(batch1.ok).toBe(true);
      if (!batch1.ok) return;
      selector.markProcessing(batch1.value.batchId, ["r1"]);
      selector.markFailed(["r1"]);

      // After dedupe window — should be re-eligible
      currentTime = new Date("2026-01-15T13:31:00Z");
      const batch2 = await selector.selectBatch();
      expect(batch2.ok).toBe(true);
      if (!batch2.ok) return;
      expect(batch2.value.candidates).toHaveLength(1);
      expect(batch2.value.candidates[0].record.id).toBe("r1");
      expect(batch2.value.candidates[0].retryCount).toBe(1);
    });
  });

  describe("status transitions", () => {
    it("transitions eligible to processing", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now, () => "batch-1");
      const batch = await selector.selectBatch();
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;

      const result = selector.markProcessing("batch-1", ["r1"]);
      expect(result.ok).toBe(true);

      const status = selector.getCandidateStatus("r1");
      expect(status?.status).toBe("processing");
    });

    it("transitions processing to consolidated", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now, () => "batch-1");
      await selector.selectBatch();
      selector.markProcessing("batch-1", ["r1"]);

      const result = selector.markConsolidated(["r1"]);
      expect(result.ok).toBe(true);

      const status = selector.getCandidateStatus("r1");
      expect(status?.status).toBe("consolidated");
    });

    it("transitions processing to failed with retry increment", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0, maxRetries: 3 }, () => now, () => "batch-1");
      await selector.selectBatch();
      selector.markProcessing("batch-1", ["r1"]);

      const result = selector.markFailed(["r1"]);
      expect(result.ok).toBe(true);

      const status = selector.getCandidateStatus("r1");
      expect(status?.status).toBe("failed");
      expect(status?.retryCount).toBe(1);
    });

    it("transitions to skipped when max retries exhausted", async () => {
      let currentTime = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      let batchNum = 0;
      const selector = new StmSelector({
        source: makeSource(records),
        config: { minAgeMs: 0, maxRetries: 2, dedupeWindowMs: 0 },
        now: () => currentTime,
        generateId: () => `batch-${++batchNum}`,
      });

      // Attempt 1: select → process → fail
      const batch1 = await selector.selectBatch();
      expect(batch1.ok).toBe(true);
      if (!batch1.ok) return;
      selector.markProcessing(batch1.value.batchId, ["r1"]);
      selector.markFailed(["r1"]);

      // After dedupe window
      currentTime = new Date("2026-01-15T13:01:00Z");

      // Attempt 2: select → process → fail → should become skipped
      const batch2 = await selector.selectBatch();
      expect(batch2.ok).toBe(true);
      if (!batch2.ok) return;
      expect(batch2.value.candidates).toHaveLength(1);
      selector.markProcessing(batch2.value.batchId, ["r1"]);
      selector.markFailed(["r1"]);

      const status = selector.getCandidateStatus("r1");
      expect(status?.status).toBe("skipped");
      expect(status?.retryCount).toBe(2);

      // Skipped records should not be re-selected
      currentTime = new Date("2026-01-15T14:00:00Z");
      const batch3 = await selector.selectBatch();
      expect(batch3.ok).toBe(true);
      if (!batch3.ok) return;
      expect(batch3.value.candidates).toHaveLength(0);
    });

    it("ignores markProcessing for wrong batchId", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now, () => "batch-1");
      await selector.selectBatch();

      selector.markProcessing("wrong-batch", ["r1"]);

      const status = selector.getCandidateStatus("r1");
      expect(status?.status).toBe("eligible");
    });

    it("ignores markConsolidated for non-processing candidates", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now, () => "batch-1");
      await selector.selectBatch();

      // r1 is eligible, not processing — markConsolidated should be a no-op
      selector.markConsolidated(["r1"]);

      const status = selector.getCandidateStatus("r1");
      expect(status?.status).toBe("eligible");
    });

    it("ignores markFailed for non-processing candidates", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now, () => "batch-1");
      await selector.selectBatch();

      // r1 is eligible, not processing — markFailed should be a no-op
      selector.markFailed(["r1"]);

      const status = selector.getCandidateStatus("r1");
      expect(status?.status).toBe("eligible");
    });

    it("is idempotent for markConsolidated on already-consolidated candidates", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now, () => "batch-1");
      await selector.selectBatch();
      selector.markProcessing("batch-1", ["r1"]);
      selector.markConsolidated(["r1"]);

      // Second call should be a no-op
      const result = selector.markConsolidated(["r1"]);
      expect(result.ok).toBe(true);

      const status = selector.getCandidateStatus("r1");
      expect(status?.status).toBe("consolidated");
    });

    it("is idempotent for markFailed on already-failed candidates", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0, maxRetries: 5 }, () => now, () => "batch-1");
      await selector.selectBatch();
      selector.markProcessing("batch-1", ["r1"]);
      selector.markFailed(["r1"]);

      const statusBefore = selector.getCandidateStatus("r1");
      expect(statusBefore?.retryCount).toBe(1);

      // Second markFailed should be a no-op (status is "failed", not "processing")
      selector.markFailed(["r1"]);

      const statusAfter = selector.getCandidateStatus("r1");
      expect(statusAfter?.retryCount).toBe(1);
    });

    it("handles unknown candidate ids gracefully", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const selector = makeSelector([], { minAgeMs: 0 }, () => now);

      const result1 = selector.markProcessing("batch-1", ["nonexistent"]);
      expect(result1.ok).toBe(true);

      const result2 = selector.markConsolidated(["nonexistent"]);
      expect(result2.ok).toBe(true);

      const result3 = selector.markFailed(["nonexistent"]);
      expect(result3.ok).toBe(true);
    });
  });

  describe("retry count tracking", () => {
    it("preserves retry count across re-selection after failure", async () => {
      let currentTime = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      let batchNum = 0;
      const selector = new StmSelector({
        source: makeSource(records),
        config: { minAgeMs: 0, maxRetries: 5, dedupeWindowMs: 0 },
        now: () => currentTime,
        generateId: () => `batch-${++batchNum}`,
      });

      // First attempt: fail
      const batch1 = await selector.selectBatch();
      expect(batch1.ok).toBe(true);
      if (!batch1.ok) return;
      selector.markProcessing(batch1.value.batchId, ["r1"]);
      selector.markFailed(["r1"]);

      // Re-select after dedupe window
      currentTime = new Date("2026-01-15T13:01:00Z");
      const batch2 = await selector.selectBatch();
      expect(batch2.ok).toBe(true);
      if (!batch2.ok) return;

      expect(batch2.value.candidates[0].retryCount).toBe(1);
    });

    it("increments retry count on each failure", async () => {
      let currentTime = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      let batchNum = 0;
      const selector = new StmSelector({
        source: makeSource(records),
        config: { minAgeMs: 0, maxRetries: 5, dedupeWindowMs: 0 },
        now: () => currentTime,
        generateId: () => `batch-${++batchNum}`,
      });

      // Fail 3 times
      for (let i = 0; i < 3; i++) {
        const batch = await selector.selectBatch();
        expect(batch.ok).toBe(true);
        if (!batch.ok) return;
        selector.markProcessing(batch.value.batchId, ["r1"]);
        selector.markFailed(["r1"]);
        currentTime = new Date(currentTime.getTime() + 60_000);
      }

      const status = selector.getCandidateStatus("r1");
      expect(status?.retryCount).toBe(3);
    });
  });

  describe("batch with multiple candidates", () => {
    it("handles mixed transitions across candidates in same batch", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({ id: "r2", createdAt: new Date("2026-01-15T12:01:00Z") }),
        makeRecord({ id: "r3", createdAt: new Date("2026-01-15T12:02:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0, maxRetries: 3 }, () => now, () => "batch-1");
      const batch = await selector.selectBatch();
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;

      selector.markProcessing("batch-1", ["r1", "r2", "r3"]);
      selector.markConsolidated(["r1"]);
      selector.markFailed(["r2"]);
      // r3 stays processing

      expect(selector.getCandidateStatus("r1")?.status).toBe("consolidated");
      expect(selector.getCandidateStatus("r2")?.status).toBe("failed");
      expect(selector.getCandidateStatus("r3")?.status).toBe("processing");
    });
  });

  describe("DEFAULT_BATCH_CONFIG", () => {
    it("has sensible defaults", () => {
      expect(DEFAULT_BATCH_CONFIG.batchSize).toBe(20);
      expect(DEFAULT_BATCH_CONFIG.dedupeWindowMs).toBe(30 * 60 * 1000);
      expect(DEFAULT_BATCH_CONFIG.maxRetries).toBe(3);
      expect(DEFAULT_BATCH_CONFIG.minAgeMs).toBe(5 * 60 * 1000);
    });
  });

  describe("edge cases", () => {
    it("handles batch larger than available records", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = makeSelector(records, { batchSize: 100, minAgeMs: 0 }, () => now);
      const result = await selector.selectBatch();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.candidates).toHaveLength(1);
    });

    it("excludes processing candidates from subsequent batches", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({ id: "r2", createdAt: new Date("2026-01-15T12:01:00Z") }),
      ];

      let batchNum = 0;
      const selector = new StmSelector({
        source: makeSource(records),
        config: { minAgeMs: 0 },
        now: () => now,
        generateId: () => `batch-${++batchNum}`,
      });

      const batch1 = await selector.selectBatch();
      expect(batch1.ok).toBe(true);
      if (!batch1.ok) return;

      selector.markProcessing(batch1.value.batchId, ["r1"]);

      const batch2 = await selector.selectBatch();
      expect(batch2.ok).toBe(true);
      if (!batch2.ok) return;

      const ids = batch2.value.candidates.map((c) => c.record.id);
      expect(ids).not.toContain("r1");
      expect(ids).toContain("r2");
    });

    it("handles all records already processed", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
        makeRecord({ id: "r2", createdAt: new Date("2026-01-15T12:01:00Z") }),
      ];

      const selector = makeSelector(records, { minAgeMs: 0 }, () => now, () => "batch-1");
      const batch = await selector.selectBatch();
      expect(batch.ok).toBe(true);
      if (!batch.ok) return;

      selector.markProcessing("batch-1", ["r1", "r2"]);
      selector.markConsolidated(["r1", "r2"]);

      const batch2 = await selector.selectBatch();
      expect(batch2.ok).toBe(true);
      if (!batch2.ok) return;
      expect(batch2.value.candidates).toHaveLength(0);
    });

    it("uses default config values when none provided", async () => {
      const now = new Date("2026-01-15T13:00:00Z");
      const records = [
        makeRecord({ id: "r1", createdAt: new Date("2026-01-15T12:00:00Z") }),
      ];

      const selector = new StmSelector({
        source: makeSource(records),
        now: () => now,
      });

      const result = await selector.selectBatch();
      expect(result.ok).toBe(true);
    });
  });
});
