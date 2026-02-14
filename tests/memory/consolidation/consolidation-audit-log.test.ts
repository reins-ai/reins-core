import { describe, expect, it } from "bun:test";

import {
  ConsolidationAuditLog,
  ConsolidationAuditLogError,
  type AuditEntry,
  type RollbackMarker,
} from "../../../src/memory/consolidation/consolidation-audit-log";
import type { MemoryRecord } from "../../../src/memory/types";

function makeRecord(id: string, overrides?: Partial<MemoryRecord>): MemoryRecord {
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
      sourceType: "consolidation",
      conversationId: "conv-1",
    },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    ...overrides,
  };
}

function makeEntry(runId: string, overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    runId,
    timestamp: new Date("2026-02-13T14:00:00.000Z"),
    durationMs: 150,
    status: "success",
    candidateCount: 5,
    candidateIds: ["cand-1", "cand-2", "cand-3", "cand-4", "cand-5"],
    factsCreated: 3,
    factsUpdated: 1,
    factsSuperseded: 1,
    factsSkipped: 0,
    errors: [],
    ...overrides,
  };
}

function makeMarker(
  markerId: string,
  runId: string,
  overrides?: Partial<RollbackMarker>,
): RollbackMarker {
  return {
    markerId,
    runId,
    action: "create",
    targetRecordId: "ltm-1",
    previousState: null,
    newState: makeRecord("ltm-1"),
    reversible: true,
    ...overrides,
  };
}

describe("ConsolidationAuditLog", () => {
  describe("recordRun", () => {
    it("records a successful run and retrieves it", () => {
      const log = new ConsolidationAuditLog();
      const entry = makeEntry("run-1");

      log.recordRun(entry);

      const history = log.getRunHistory();
      expect(history).toHaveLength(1);
      expect(history[0].runId).toBe("run-1");
      expect(history[0].status).toBe("success");
      expect(history[0].factsCreated).toBe(3);
    });

    it("records a failed run", () => {
      const log = new ConsolidationAuditLog();
      const entry = makeEntry("run-fail", {
        status: "failed",
        factsCreated: 0,
        factsUpdated: 0,
        factsSuperseded: 0,
        factsSkipped: 5,
        errors: ["Distillation provider unavailable", "Timeout exceeded"],
      });

      log.recordRun(entry);

      const history = log.getRunHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("failed");
      expect(history[0].errors).toHaveLength(2);
      expect(history[0].errors[0]).toBe("Distillation provider unavailable");
    });

    it("records a partial run", () => {
      const log = new ConsolidationAuditLog();
      const entry = makeEntry("run-partial", {
        status: "partial",
        factsCreated: 2,
        factsSkipped: 3,
        errors: ["Candidate cand-3 failed schema validation"],
      });

      log.recordRun(entry);

      const history = log.getRunHistory();
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe("partial");
      expect(history[0].factsCreated).toBe(2);
      expect(history[0].factsSkipped).toBe(3);
    });

    it("throws on empty runId", () => {
      const log = new ConsolidationAuditLog();
      expect(() => log.recordRun(makeEntry(""))).toThrow(ConsolidationAuditLogError);
    });

    it("throws on whitespace-only runId", () => {
      const log = new ConsolidationAuditLog();
      expect(() => log.recordRun(makeEntry("   "))).toThrow(ConsolidationAuditLogError);
    });

    it("throws on duplicate runId", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));
      expect(() => log.recordRun(makeEntry("run-1"))).toThrow(ConsolidationAuditLogError);
    });
  });

  describe("addRollbackMarker", () => {
    it("adds a create marker and retrieves by run", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));

      const marker = makeMarker("m-1", "run-1", {
        action: "create",
        targetRecordId: "ltm-new-1",
        previousState: null,
        newState: makeRecord("ltm-new-1"),
        reversible: true,
      });
      log.addRollbackMarker(marker);

      const markers = log.getMarkersForRun("run-1");
      expect(markers).toHaveLength(1);
      expect(markers[0].action).toBe("create");
      expect(markers[0].previousState).toBeNull();
      expect(markers[0].newState.id).toBe("ltm-new-1");
    });

    it("adds an update marker with previous state snapshot", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));

      const previousState = makeRecord("ltm-1", { importance: 0.5 });
      const newState = makeRecord("ltm-1", { importance: 0.7 });

      log.addRollbackMarker(makeMarker("m-1", "run-1", {
        action: "update",
        targetRecordId: "ltm-1",
        previousState,
        newState,
        reversible: true,
      }));

      const markers = log.getMarkersForRun("run-1");
      expect(markers).toHaveLength(1);
      expect(markers[0].action).toBe("update");
      expect(markers[0].previousState?.importance).toBe(0.5);
      expect(markers[0].newState.importance).toBe(0.7);
    });

    it("adds a supersede marker", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));

      const previousState = makeRecord("ltm-old", { supersededBy: undefined });
      const newState = makeRecord("ltm-old", { supersededBy: "ltm-new" });

      log.addRollbackMarker(makeMarker("m-1", "run-1", {
        action: "supersede",
        targetRecordId: "ltm-old",
        previousState,
        newState,
        reversible: true,
      }));

      const markers = log.getMarkersForRun("run-1");
      expect(markers[0].action).toBe("supersede");
      expect(markers[0].previousState?.supersededBy).toBeUndefined();
      expect(markers[0].newState.supersededBy).toBe("ltm-new");
    });

    it("throws on empty markerId", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));
      expect(() => log.addRollbackMarker(makeMarker("", "run-1"))).toThrow(
        ConsolidationAuditLogError,
      );
    });

    it("throws when run does not exist", () => {
      const log = new ConsolidationAuditLog();
      expect(() => log.addRollbackMarker(makeMarker("m-1", "nonexistent"))).toThrow(
        ConsolidationAuditLogError,
      );
    });

    it("supports multiple markers per run", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));

      log.addRollbackMarker(makeMarker("m-1", "run-1", { targetRecordId: "ltm-1" }));
      log.addRollbackMarker(makeMarker("m-2", "run-1", { targetRecordId: "ltm-2" }));
      log.addRollbackMarker(makeMarker("m-3", "run-1", { targetRecordId: "ltm-3" }));

      const markers = log.getMarkersForRun("run-1");
      expect(markers).toHaveLength(3);
    });
  });

  describe("getRunHistory", () => {
    it("returns runs sorted by timestamp descending", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { timestamp: new Date("2026-02-13T10:00:00Z") }));
      log.recordRun(makeEntry("run-2", { timestamp: new Date("2026-02-13T14:00:00Z") }));
      log.recordRun(makeEntry("run-3", { timestamp: new Date("2026-02-13T12:00:00Z") }));

      const history = log.getRunHistory();
      expect(history).toHaveLength(3);
      expect(history[0].runId).toBe("run-2");
      expect(history[1].runId).toBe("run-3");
      expect(history[2].runId).toBe("run-1");
    });

    it("filters by date range", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { timestamp: new Date("2026-02-10T10:00:00Z") }));
      log.recordRun(makeEntry("run-2", { timestamp: new Date("2026-02-12T10:00:00Z") }));
      log.recordRun(makeEntry("run-3", { timestamp: new Date("2026-02-14T10:00:00Z") }));

      const history = log.getRunHistory({
        startDate: new Date("2026-02-11T00:00:00Z"),
        endDate: new Date("2026-02-13T00:00:00Z"),
      });

      expect(history).toHaveLength(1);
      expect(history[0].runId).toBe("run-2");
    });

    it("filters by start date only", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { timestamp: new Date("2026-02-10T10:00:00Z") }));
      log.recordRun(makeEntry("run-2", { timestamp: new Date("2026-02-14T10:00:00Z") }));

      const history = log.getRunHistory({
        startDate: new Date("2026-02-12T00:00:00Z"),
      });

      expect(history).toHaveLength(1);
      expect(history[0].runId).toBe("run-2");
    });

    it("filters by end date only", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { timestamp: new Date("2026-02-10T10:00:00Z") }));
      log.recordRun(makeEntry("run-2", { timestamp: new Date("2026-02-14T10:00:00Z") }));

      const history = log.getRunHistory({
        endDate: new Date("2026-02-12T00:00:00Z"),
      });

      expect(history).toHaveLength(1);
      expect(history[0].runId).toBe("run-1");
    });

    it("filters by status", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { status: "success" }));
      log.recordRun(makeEntry("run-2", { status: "failed" }));
      log.recordRun(makeEntry("run-3", { status: "partial" }));
      log.recordRun(makeEntry("run-4", { status: "success" }));

      const history = log.getRunHistory({ status: "success" });
      expect(history).toHaveLength(2);
      expect(history.every((e) => e.status === "success")).toBe(true);
    });

    it("applies limit", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { timestamp: new Date("2026-02-13T10:00:00Z") }));
      log.recordRun(makeEntry("run-2", { timestamp: new Date("2026-02-13T12:00:00Z") }));
      log.recordRun(makeEntry("run-3", { timestamp: new Date("2026-02-13T14:00:00Z") }));

      const history = log.getRunHistory({ limit: 2 });
      expect(history).toHaveLength(2);
      expect(history[0].runId).toBe("run-3");
      expect(history[1].runId).toBe("run-2");
    });

    it("combines status and date filters", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", {
        status: "success",
        timestamp: new Date("2026-02-10T10:00:00Z"),
      }));
      log.recordRun(makeEntry("run-2", {
        status: "failed",
        timestamp: new Date("2026-02-12T10:00:00Z"),
      }));
      log.recordRun(makeEntry("run-3", {
        status: "success",
        timestamp: new Date("2026-02-14T10:00:00Z"),
      }));

      const history = log.getRunHistory({
        status: "success",
        startDate: new Date("2026-02-11T00:00:00Z"),
      });

      expect(history).toHaveLength(1);
      expect(history[0].runId).toBe("run-3");
    });

    it("returns empty array when no runs match", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { status: "success" }));

      const history = log.getRunHistory({ status: "failed" });
      expect(history).toHaveLength(0);
    });

    it("returns empty array on empty log", () => {
      const log = new ConsolidationAuditLog();
      const history = log.getRunHistory();
      expect(history).toHaveLength(0);
    });
  });

  describe("getMarkersForRun", () => {
    it("returns empty array for run with no markers", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));

      const markers = log.getMarkersForRun("run-1");
      expect(markers).toHaveLength(0);
    });

    it("returns empty array for unknown run", () => {
      const log = new ConsolidationAuditLog();
      const markers = log.getMarkersForRun("nonexistent");
      expect(markers).toHaveLength(0);
    });

    it("returns a defensive copy", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));
      log.addRollbackMarker(makeMarker("m-1", "run-1"));

      const markers1 = log.getMarkersForRun("run-1");
      const markers2 = log.getMarkersForRun("run-1");
      expect(markers1).not.toBe(markers2);
      expect(markers1).toEqual(markers2);
    });
  });

  describe("getRollbackChain", () => {
    it("traces all modifications to a record across multiple runs", () => {
      const log = new ConsolidationAuditLog();

      log.recordRun(makeEntry("run-1", { timestamp: new Date("2026-02-13T10:00:00Z") }));
      log.recordRun(makeEntry("run-2", { timestamp: new Date("2026-02-13T14:00:00Z") }));
      log.recordRun(makeEntry("run-3", { timestamp: new Date("2026-02-13T18:00:00Z") }));

      log.addRollbackMarker(makeMarker("m-1", "run-1", {
        action: "create",
        targetRecordId: "ltm-target",
        previousState: null,
        newState: makeRecord("ltm-target", { importance: 0.5 }),
      }));

      log.addRollbackMarker(makeMarker("m-2", "run-2", {
        action: "update",
        targetRecordId: "ltm-target",
        previousState: makeRecord("ltm-target", { importance: 0.5 }),
        newState: makeRecord("ltm-target", { importance: 0.7 }),
      }));

      log.addRollbackMarker(makeMarker("m-3", "run-3", {
        action: "supersede",
        targetRecordId: "ltm-target",
        previousState: makeRecord("ltm-target", { importance: 0.7 }),
        newState: makeRecord("ltm-target", { importance: 0.7, supersededBy: "ltm-newer" }),
      }));

      const chain = log.getRollbackChain("ltm-target");
      expect(chain).toHaveLength(3);
      expect(chain[0].markerId).toBe("m-1");
      expect(chain[0].action).toBe("create");
      expect(chain[1].markerId).toBe("m-2");
      expect(chain[1].action).toBe("update");
      expect(chain[2].markerId).toBe("m-3");
      expect(chain[2].action).toBe("supersede");
    });

    it("returns empty array for unknown record", () => {
      const log = new ConsolidationAuditLog();
      const chain = log.getRollbackChain("nonexistent");
      expect(chain).toHaveLength(0);
    });

    it("returns chain sorted by run timestamp ascending", () => {
      const log = new ConsolidationAuditLog();

      log.recordRun(makeEntry("run-late", { timestamp: new Date("2026-02-14T10:00:00Z") }));
      log.recordRun(makeEntry("run-early", { timestamp: new Date("2026-02-12T10:00:00Z") }));

      log.addRollbackMarker(makeMarker("m-late", "run-late", { targetRecordId: "ltm-x" }));
      log.addRollbackMarker(makeMarker("m-early", "run-early", { targetRecordId: "ltm-x" }));

      const chain = log.getRollbackChain("ltm-x");
      expect(chain[0].markerId).toBe("m-early");
      expect(chain[1].markerId).toBe("m-late");
    });

    it("only returns markers for the requested record", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));

      log.addRollbackMarker(makeMarker("m-1", "run-1", { targetRecordId: "ltm-a" }));
      log.addRollbackMarker(makeMarker("m-2", "run-1", { targetRecordId: "ltm-b" }));
      log.addRollbackMarker(makeMarker("m-3", "run-1", { targetRecordId: "ltm-a" }));

      const chain = log.getRollbackChain("ltm-a");
      expect(chain).toHaveLength(2);
      expect(chain.every((m) => m.targetRecordId === "ltm-a")).toBe(true);
    });
  });

  describe("getSummary", () => {
    it("computes summary statistics across all runs", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", {
        status: "success",
        durationMs: 100,
        factsCreated: 3,
        factsUpdated: 1,
        factsSuperseded: 0,
        factsSkipped: 1,
      }));
      log.recordRun(makeEntry("run-2", {
        status: "partial",
        durationMs: 200,
        factsCreated: 1,
        factsUpdated: 0,
        factsSuperseded: 1,
        factsSkipped: 3,
      }));
      log.recordRun(makeEntry("run-3", {
        status: "failed",
        durationMs: 50,
        factsCreated: 0,
        factsUpdated: 0,
        factsSuperseded: 0,
        factsSkipped: 5,
      }));

      const summary = log.getSummary();
      expect(summary.totalRuns).toBe(3);
      expect(summary.successCount).toBe(1);
      expect(summary.partialCount).toBe(1);
      expect(summary.failedCount).toBe(1);
      expect(summary.successRate).toBeCloseTo(1 / 3);
      expect(summary.averageDurationMs).toBeCloseTo((100 + 200 + 50) / 3);
      expect(summary.totalFactsCreated).toBe(4);
      expect(summary.totalFactsUpdated).toBe(1);
      expect(summary.totalFactsSuperseded).toBe(1);
      expect(summary.totalFactsSkipped).toBe(9);
    });

    it("returns zero summary for empty log", () => {
      const log = new ConsolidationAuditLog();
      const summary = log.getSummary();

      expect(summary.totalRuns).toBe(0);
      expect(summary.successCount).toBe(0);
      expect(summary.successRate).toBe(0);
      expect(summary.averageDurationMs).toBe(0);
    });

    it("respects query options for filtered summary", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", {
        status: "success",
        timestamp: new Date("2026-02-10T10:00:00Z"),
        durationMs: 100,
      }));
      log.recordRun(makeEntry("run-2", {
        status: "success",
        timestamp: new Date("2026-02-14T10:00:00Z"),
        durationMs: 200,
      }));

      const summary = log.getSummary({
        startDate: new Date("2026-02-12T00:00:00Z"),
      });

      expect(summary.totalRuns).toBe(1);
      expect(summary.averageDurationMs).toBe(200);
    });

    it("computes 100% success rate when all runs succeed", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { status: "success" }));
      log.recordRun(makeEntry("run-2", { status: "success" }));

      const summary = log.getSummary();
      expect(summary.successRate).toBe(1);
    });

    it("computes 0% success rate when all runs fail", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { status: "failed" }));
      log.recordRun(makeEntry("run-2", { status: "failed" }));

      const summary = log.getSummary();
      expect(summary.successRate).toBe(0);
    });
  });

  describe("serialize / deserialize", () => {
    it("round-trips entries and markers", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", {
        timestamp: new Date("2026-02-13T10:00:00.000Z"),
      }));
      log.recordRun(makeEntry("run-2", {
        status: "failed",
        timestamp: new Date("2026-02-13T14:00:00.000Z"),
        errors: ["Provider timeout"],
      }));

      const prevState = makeRecord("ltm-1", { importance: 0.5 });
      const newState = makeRecord("ltm-1", { importance: 0.7 });

      log.addRollbackMarker(makeMarker("m-1", "run-1", {
        action: "create",
        targetRecordId: "ltm-new",
        previousState: null,
        newState: makeRecord("ltm-new"),
      }));
      log.addRollbackMarker(makeMarker("m-2", "run-1", {
        action: "update",
        targetRecordId: "ltm-1",
        previousState: prevState,
        newState: newState,
      }));

      const json = log.serialize();
      const restored = ConsolidationAuditLog.deserialize(json);

      const history = restored.getRunHistory();
      expect(history).toHaveLength(2);
      expect(history[0].runId).toBe("run-2");
      expect(history[0].status).toBe("failed");
      expect(history[0].errors).toEqual(["Provider timeout"]);
      expect(history[1].runId).toBe("run-1");

      const markers = restored.getMarkersForRun("run-1");
      expect(markers).toHaveLength(2);
      expect(markers[0].markerId).toBe("m-1");
      expect(markers[0].previousState).toBeNull();
      expect(markers[0].newState.id).toBe("ltm-new");
      expect(markers[1].markerId).toBe("m-2");
      expect(markers[1].previousState?.importance).toBe(0.5);
      expect(markers[1].newState.importance).toBe(0.7);
    });

    it("preserves date types after round-trip", () => {
      const log = new ConsolidationAuditLog();
      const timestamp = new Date("2026-02-13T10:30:00.000Z");
      log.recordRun(makeEntry("run-1", { timestamp }));

      const json = log.serialize();
      const restored = ConsolidationAuditLog.deserialize(json);

      const history = restored.getRunHistory();
      expect(history[0].timestamp).toBeInstanceOf(Date);
      expect(history[0].timestamp.toISOString()).toBe(timestamp.toISOString());
    });

    it("preserves rollback chain after round-trip", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { timestamp: new Date("2026-02-13T10:00:00Z") }));
      log.recordRun(makeEntry("run-2", { timestamp: new Date("2026-02-13T14:00:00Z") }));

      log.addRollbackMarker(makeMarker("m-1", "run-1", { targetRecordId: "ltm-x" }));
      log.addRollbackMarker(makeMarker("m-2", "run-2", { targetRecordId: "ltm-x" }));

      const json = log.serialize();
      const restored = ConsolidationAuditLog.deserialize(json);

      const chain = restored.getRollbackChain("ltm-x");
      expect(chain).toHaveLength(2);
      expect(chain[0].markerId).toBe("m-1");
      expect(chain[1].markerId).toBe("m-2");
    });

    it("preserves summary statistics after round-trip", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1", { status: "success", durationMs: 100 }));
      log.recordRun(makeEntry("run-2", { status: "failed", durationMs: 200 }));

      const originalSummary = log.getSummary();
      const json = log.serialize();
      const restored = ConsolidationAuditLog.deserialize(json);
      const restoredSummary = restored.getSummary();

      expect(restoredSummary.totalRuns).toBe(originalSummary.totalRuns);
      expect(restoredSummary.successCount).toBe(originalSummary.successCount);
      expect(restoredSummary.failedCount).toBe(originalSummary.failedCount);
      expect(restoredSummary.successRate).toBe(originalSummary.successRate);
    });

    it("serializes to valid JSON", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));

      const json = log.serialize();
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it("deserializes empty log", () => {
      const log = new ConsolidationAuditLog();
      const json = log.serialize();
      const restored = ConsolidationAuditLog.deserialize(json);

      expect(restored.getRunHistory()).toHaveLength(0);
      expect(restored.getSummary().totalRuns).toBe(0);
    });

    it("throws on invalid JSON", () => {
      expect(() => ConsolidationAuditLog.deserialize("not json")).toThrow(
        ConsolidationAuditLogError,
      );
    });

    it("throws on unsupported version", () => {
      expect(() =>
        ConsolidationAuditLog.deserialize(JSON.stringify({ version: 99, entries: [], markers: [] })),
      ).toThrow(ConsolidationAuditLogError);
    });

    it("throws on missing entries array", () => {
      expect(() =>
        ConsolidationAuditLog.deserialize(JSON.stringify({ version: 1 })),
      ).toThrow(ConsolidationAuditLogError);
    });

    it("preserves memory record fields in marker states", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));

      const record = makeRecord("ltm-1", {
        content: "User prefers dark mode",
        type: "preference",
        tags: ["ui", "theme"],
        entities: ["user", "dark-mode"],
        supersedes: "ltm-old",
        provenance: { sourceType: "consolidation", conversationId: "conv-42" },
      });

      log.addRollbackMarker(makeMarker("m-1", "run-1", {
        targetRecordId: "ltm-1",
        previousState: null,
        newState: record,
      }));

      const json = log.serialize();
      const restored = ConsolidationAuditLog.deserialize(json);
      const markers = restored.getMarkersForRun("run-1");

      expect(markers[0].newState.content).toBe("User prefers dark mode");
      expect(markers[0].newState.type).toBe("preference");
      expect(markers[0].newState.tags).toEqual(["ui", "theme"]);
      expect(markers[0].newState.entities).toEqual(["user", "dark-mode"]);
      expect(markers[0].newState.supersedes).toBe("ltm-old");
      expect(markers[0].newState.provenance.conversationId).toBe("conv-42");
    });
  });

  describe("non-reversible markers", () => {
    it("supports markers flagged as non-reversible", () => {
      const log = new ConsolidationAuditLog();
      log.recordRun(makeEntry("run-1"));

      log.addRollbackMarker(makeMarker("m-1", "run-1", {
        reversible: false,
      }));

      const markers = log.getMarkersForRun("run-1");
      expect(markers[0].reversible).toBe(false);
    });
  });

  describe("integration scenario", () => {
    it("handles a multi-run consolidation lifecycle", () => {
      const log = new ConsolidationAuditLog();

      // Run 1: creates 2 new LTM records
      log.recordRun(makeEntry("run-1", {
        timestamp: new Date("2026-02-13T08:00:00Z"),
        candidateCount: 4,
        candidateIds: ["c-1", "c-2", "c-3", "c-4"],
        factsCreated: 2,
        factsUpdated: 0,
        factsSuperseded: 0,
        factsSkipped: 2,
      }));

      log.addRollbackMarker(makeMarker("m-1", "run-1", {
        action: "create",
        targetRecordId: "ltm-100",
        previousState: null,
        newState: makeRecord("ltm-100", { content: "User likes TypeScript" }),
      }));
      log.addRollbackMarker(makeMarker("m-2", "run-1", {
        action: "create",
        targetRecordId: "ltm-101",
        previousState: null,
        newState: makeRecord("ltm-101", { content: "User uses Bun runtime" }),
      }));

      // Run 2: reinforces ltm-100, supersedes ltm-101
      log.recordRun(makeEntry("run-2", {
        timestamp: new Date("2026-02-13T16:00:00Z"),
        candidateCount: 3,
        candidateIds: ["c-5", "c-6", "c-7"],
        factsCreated: 1,
        factsUpdated: 1,
        factsSuperseded: 1,
        factsSkipped: 0,
      }));

      log.addRollbackMarker(makeMarker("m-3", "run-2", {
        action: "update",
        targetRecordId: "ltm-100",
        previousState: makeRecord("ltm-100", { importance: 0.5 }),
        newState: makeRecord("ltm-100", { importance: 0.7 }),
      }));
      log.addRollbackMarker(makeMarker("m-4", "run-2", {
        action: "supersede",
        targetRecordId: "ltm-101",
        previousState: makeRecord("ltm-101"),
        newState: makeRecord("ltm-101", { supersededBy: "ltm-102" }),
      }));
      log.addRollbackMarker(makeMarker("m-5", "run-2", {
        action: "create",
        targetRecordId: "ltm-102",
        previousState: null,
        newState: makeRecord("ltm-102", { content: "User uses Deno runtime", supersedes: "ltm-101" }),
      }));

      // Verify run history
      const history = log.getRunHistory();
      expect(history).toHaveLength(2);
      expect(history[0].runId).toBe("run-2");

      // Verify rollback chain for ltm-100 (created then updated)
      const chain100 = log.getRollbackChain("ltm-100");
      expect(chain100).toHaveLength(2);
      expect(chain100[0].action).toBe("create");
      expect(chain100[1].action).toBe("update");

      // Verify rollback chain for ltm-101 (created then superseded)
      const chain101 = log.getRollbackChain("ltm-101");
      expect(chain101).toHaveLength(2);
      expect(chain101[0].action).toBe("create");
      expect(chain101[1].action).toBe("supersede");

      // Verify summary
      const summary = log.getSummary();
      expect(summary.totalRuns).toBe(2);
      expect(summary.successRate).toBe(1);
      expect(summary.totalFactsCreated).toBe(3);
      expect(summary.totalFactsUpdated).toBe(1);
      expect(summary.totalFactsSuperseded).toBe(1);
      expect(summary.totalFactsSkipped).toBe(2);

      // Verify serialization round-trip preserves everything
      const json = log.serialize();
      const restored = ConsolidationAuditLog.deserialize(json);

      expect(restored.getRunHistory()).toHaveLength(2);
      expect(restored.getRollbackChain("ltm-100")).toHaveLength(2);
      expect(restored.getRollbackChain("ltm-101")).toHaveLength(2);
      expect(restored.getMarkersForRun("run-2")).toHaveLength(3);
      expect(restored.getSummary().totalRuns).toBe(2);
    });
  });
});
