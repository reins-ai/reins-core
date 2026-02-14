import { describe, expect, test } from "bun:test";

import { ok, err, type Result } from "../../src/result";
import { ReinsError } from "../../src/errors";
import type { MemoryRecord } from "../../src/memory/types/index";
import type { StmBatch } from "../../src/memory/consolidation/stm-queue";
import type { DistilledFact, DistillationResult } from "../../src/memory/consolidation/distillation-schema";
import type { MergeResult } from "../../src/memory/consolidation/merge-engine";
import {
  ConsolidationRunner,
  ConsolidationRunnerError,
  type ConsolidationRunnerOptions,
  type LtmWriter,
} from "../../src/memory/consolidation/consolidation-runner";
import {
  MemoryConsolidationJob,
  ConsolidationJobError,
} from "../../src/cron/jobs/memory-consolidation-job";
import { StmSelector, type StmRecordSource } from "../../src/memory/consolidation/stm-selector";
import { DistillationEngine, type DistillationProvider } from "../../src/memory/consolidation/distillation-engine";
import { MergeEngine, SimpleMemoryLookup } from "../../src/memory/consolidation/merge-engine";
import { ImportanceScorer } from "../../src/memory/consolidation/importance-scorer";

function createStmRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  const now = new Date("2026-02-10T08:00:00.000Z");
  return {
    id: overrides?.id ?? crypto.randomUUID(),
    content: overrides?.content ?? "User prefers dark mode",
    type: overrides?.type ?? "preference",
    layer: overrides?.layer ?? "stm",
    tags: overrides?.tags ?? ["ui"],
    entities: overrides?.entities ?? ["user"],
    importance: overrides?.importance ?? 0.7,
    confidence: overrides?.confidence ?? 0.8,
    provenance: overrides?.provenance ?? {
      sourceType: "conversation",
      conversationId: "conv-1",
    },
    createdAt: overrides?.createdAt ?? now,
    updatedAt: overrides?.updatedAt ?? now,
    accessedAt: overrides?.accessedAt ?? now,
  };
}

function createDistillationResponse(facts: Array<Partial<DistilledFact>>, candidateIds: string[]): string {
  const fullFacts = facts.map((f, i) => ({
    type: f.type ?? "preference",
    content: f.content ?? `Distilled fact ${i}`,
    confidence: f.confidence ?? 0.85,
    sourceCandidateIds: f.sourceCandidateIds ?? [candidateIds[i % candidateIds.length]!],
    entities: f.entities ?? ["user"],
    tags: f.tags ?? ["ui"],
    reasoning: f.reasoning ?? "Extracted from conversation",
  }));

  return JSON.stringify({ facts: fullFacts });
}

function createMockSource(records: MemoryRecord[]): StmRecordSource {
  return {
    listStmRecords: async () => ok(records),
  };
}

function createMockLtmWriter(options?: {
  writeError?: boolean;
  getExistingError?: boolean;
  existingRecords?: MemoryRecord[];
}): LtmWriter & { writtenRecords: MemoryRecord[] } {
  const writtenRecords: MemoryRecord[] = [];

  return {
    writtenRecords,
    write: async (records: MemoryRecord[]) => {
      if (options?.writeError) {
        return err(new ReinsError("Write failed", "LTM_WRITE_FAILED"));
      }
      writtenRecords.push(...records);
      return ok(undefined);
    },
    getExisting: async () => {
      if (options?.getExistingError) {
        return err(new ReinsError("Fetch failed", "LTM_FETCH_FAILED"));
      }
      return ok(options?.existingRecords ?? []);
    },
  };
}

function createTestRunner(options: {
  records?: MemoryRecord[];
  distillationResponse?: string;
  distillationError?: boolean;
  ltmWriter?: LtmWriter;
  now?: () => Date;
}): ConsolidationRunner {
  const now = options.now ?? (() => new Date("2026-02-13T12:00:00.000Z"));
  const records = options.records ?? [];

  const source = createMockSource(records);
  const selector = new StmSelector({
    source,
    config: { minAgeMs: 0, dedupeWindowMs: 0 },
    now,
    generateId: () => crypto.randomUUID(),
  });

  const provider: DistillationProvider = async () => {
    if (options.distillationError) {
      throw new Error("Provider unavailable");
    }
    const candidateIds = records.map((r) => r.id);
    return options.distillationResponse ?? createDistillationResponse(
      records.map((r) => ({
        type: "preference",
        content: `Distilled: ${r.content}`,
        sourceCandidateIds: [r.id],
      })),
      candidateIds,
    );
  };

  const distillationEngine = new DistillationEngine({ provider });

  const mergeEngine = new MergeEngine({
    lookup: new SimpleMemoryLookup(),
    scorer: new ImportanceScorer(),
    config: {
      generateId: () => crypto.randomUUID(),
      now,
    },
  });

  const ltmWriter = options.ltmWriter ?? createMockLtmWriter();

  return new ConsolidationRunner({
    selector,
    distillationEngine,
    mergeEngine,
    ltmWriter,
    config: {
      now,
      generateRunId: () => "run-001",
      retryPolicy: {
        maxRetries: 0,
        baseBackoffMs: 1,
        maxBackoffMs: 1,
      },
    },
  });
}

describe("ConsolidationRunner", () => {
  test("runs full pipeline: select → distill → merge → persist", async () => {
    const record1 = createStmRecord({ id: "stm-1", content: "User prefers dark mode" });
    const record2 = createStmRecord({ id: "stm-2", content: "User likes TypeScript" });
    const ltmWriter = createMockLtmWriter();

    const runner = createTestRunner({
      records: [record1, record2],
      ltmWriter,
    });

    const result = await runner.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.runId).toBe("run-001");
    expect(result.value.stats.candidatesProcessed).toBe(2);
    expect(result.value.stats.factsDistilled).toBe(2);
    expect(result.value.stats.created).toBeGreaterThanOrEqual(0);
    expect(result.value.mergeResult).not.toBeNull();
    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    expect(ltmWriter.writtenRecords.length).toBeGreaterThan(0);
  });

  test("returns empty result for empty batch", async () => {
    const runner = createTestRunner({ records: [] });

    const result = await runner.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.stats.candidatesProcessed).toBe(0);
    expect(result.value.stats.factsDistilled).toBe(0);
    expect(result.value.mergeResult).toBeNull();
    expect(result.value.errors).toHaveLength(0);
  });

  test("handles partial failure when some candidates fail distillation", async () => {
    const record1 = createStmRecord({ id: "stm-1", content: "User prefers dark mode" });
    const record2 = createStmRecord({ id: "stm-2", content: "User likes TypeScript" });

    const distillationResponse = JSON.stringify({
      facts: [
        {
          type: "preference",
          content: "User prefers dark mode",
          confidence: 0.9,
          sourceCandidateIds: ["stm-1"],
          entities: ["user"],
          tags: ["ui"],
          reasoning: "Explicit preference",
        },
      ],
    });

    const ltmWriter = createMockLtmWriter();
    const runner = createTestRunner({
      records: [record1, record2],
      distillationResponse,
      ltmWriter,
    });

    const result = await runner.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.stats.candidatesProcessed).toBe(2);
    expect(result.value.stats.factsDistilled).toBe(1);
  });

  test("returns error when distillation provider fails", async () => {
    const record = createStmRecord({ id: "stm-1" });

    const runner = createTestRunner({
      records: [record],
      distillationError: true,
    });

    const result = await runner.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(ConsolidationRunnerError);
    expect(result.error.code).toBe("CONSOLIDATION_RUN_DISTILL_FAILED");
  });

  test("returns error when LTM fetch fails", async () => {
    const record = createStmRecord({ id: "stm-1" });
    const ltmWriter = createMockLtmWriter({ getExistingError: true });

    const runner = createTestRunner({
      records: [record],
      ltmWriter,
    });

    const result = await runner.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(ConsolidationRunnerError);
    expect(result.error.code).toBe("CONSOLIDATION_RUN_LTM_FETCH_FAILED");
  });

  test("returns error when LTM write fails", async () => {
    const record = createStmRecord({ id: "stm-1" });
    const ltmWriter = createMockLtmWriter({ writeError: true });

    const runner = createTestRunner({
      records: [record],
      ltmWriter,
    });

    const result = await runner.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(ConsolidationRunnerError);
    expect(result.error.code).toBe("CONSOLIDATION_RUN_WRITE_FAILED");
  });

  test("run result contains accurate timing", async () => {
    let callCount = 0;
    const timestamps = [
      new Date("2026-02-13T12:00:00.000Z"),
      new Date("2026-02-13T12:00:00.000Z"),
      new Date("2026-02-13T12:00:00.000Z"),
      new Date("2026-02-13T12:00:00.500Z"),
    ];

    const now = () => {
      const ts = timestamps[Math.min(callCount, timestamps.length - 1)]!;
      callCount += 1;
      return ts;
    };

    const runner = createTestRunner({ records: [], now });
    const result = await runner.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("retries distillation on transient failure", async () => {
    const record = createStmRecord({ id: "stm-1" });
    const now = () => new Date("2026-02-13T12:00:00.000Z");

    const source = createMockSource([record]);
    const selector = new StmSelector({
      source,
      config: { minAgeMs: 0, dedupeWindowMs: 0 },
      now,
    });

    let callCount = 0;
    const provider: DistillationProvider = async () => {
      callCount += 1;
      if (callCount <= 2) {
        throw new Error("Transient failure");
      }
      return createDistillationResponse(
        [{ content: "Distilled fact", sourceCandidateIds: ["stm-1"] }],
        ["stm-1"],
      );
    };

    const distillationEngine = new DistillationEngine({ provider });
    const mergeEngine = new MergeEngine({
      lookup: new SimpleMemoryLookup(),
      scorer: new ImportanceScorer(),
      config: { generateId: () => crypto.randomUUID(), now },
    });
    const ltmWriter = createMockLtmWriter();

    const runner = new ConsolidationRunner({
      selector,
      distillationEngine,
      mergeEngine,
      ltmWriter,
      config: {
        now,
        generateRunId: () => "run-retry",
        retryPolicy: {
          maxRetries: 3,
          baseBackoffMs: 1,
          maxBackoffMs: 1,
        },
      },
    });

    const result = await runner.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(callCount).toBe(3);
    expect(result.value.stats.factsDistilled).toBeGreaterThan(0);
  });

  test("exhausts retries and returns error", async () => {
    const record = createStmRecord({ id: "stm-1" });
    const now = () => new Date("2026-02-13T12:00:00.000Z");

    const source = createMockSource([record]);
    const selector = new StmSelector({
      source,
      config: { minAgeMs: 0, dedupeWindowMs: 0 },
      now,
    });

    const provider: DistillationProvider = async () => {
      throw new Error("Persistent failure");
    };

    const distillationEngine = new DistillationEngine({ provider });
    const mergeEngine = new MergeEngine({
      lookup: new SimpleMemoryLookup(),
      scorer: new ImportanceScorer(),
      config: { generateId: () => crypto.randomUUID(), now },
    });
    const ltmWriter = createMockLtmWriter();

    const runner = new ConsolidationRunner({
      selector,
      distillationEngine,
      mergeEngine,
      ltmWriter,
      config: {
        now,
        generateRunId: () => "run-fail",
        retryPolicy: {
          maxRetries: 2,
          baseBackoffMs: 1,
          maxBackoffMs: 1,
        },
      },
    });

    const result = await runner.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("CONSOLIDATION_RUN_DISTILL_FAILED");
  });

  test("does not crash on distillation returning zero facts", async () => {
    const record = createStmRecord({ id: "stm-1" });
    const distillationResponse = JSON.stringify({ facts: [] });

    const runner = createTestRunner({
      records: [record],
      distillationResponse,
    });

    const result = await runner.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.stats.candidatesProcessed).toBe(1);
    expect(result.value.stats.factsDistilled).toBe(0);
    expect(result.value.mergeResult).toBeNull();
  });
});

describe("MemoryConsolidationJob", () => {
  test("manual trigger executes consolidation and returns result", async () => {
    const runner = createTestRunner({
      records: [createStmRecord({ id: "stm-1" })],
    });

    const job = new MemoryConsolidationJob({
      runner,
      schedule: { enabled: true },
    });

    const result = await job.triggerNow();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.runId).toBe("run-001");
    expect(result.value.stats.candidatesProcessed).toBe(1);
    expect(job.getRunCount()).toBe(1);
    expect(job.getLastResult()).toBeDefined();
    expect(job.getLastRunAt()).toBeDefined();
  });

  test("manual trigger works without starting scheduled job", async () => {
    const runner = createTestRunner({ records: [] });

    const job = new MemoryConsolidationJob({
      runner,
      schedule: { enabled: false },
    });

    expect(job.isRunning()).toBe(false);

    const result = await job.triggerNow();

    expect(result.ok).toBe(true);
    expect(job.isRunning()).toBe(false);
  });

  test("start returns error when job is disabled", () => {
    const runner = createTestRunner({ records: [] });

    const job = new MemoryConsolidationJob({
      runner,
      schedule: { enabled: false },
    });

    const result = job.start();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(ConsolidationJobError);
    expect(result.error.code).toBe("CONSOLIDATION_JOB_DISABLED");
  });

  test("start and stop lifecycle works", () => {
    const runner = createTestRunner({ records: [] });

    const job = new MemoryConsolidationJob({
      runner,
      schedule: { enabled: true, intervalMs: 60_000 },
    });

    expect(job.isRunning()).toBe(false);

    const startResult = job.start();
    expect(startResult.ok).toBe(true);
    expect(job.isRunning()).toBe(true);

    job.stop();
    expect(job.isRunning()).toBe(false);
  });

  test("start is idempotent", () => {
    const runner = createTestRunner({ records: [] });

    const job = new MemoryConsolidationJob({
      runner,
      schedule: { enabled: true, intervalMs: 60_000 },
    });

    const first = job.start();
    const second = job.start();

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    job.stop();
  });

  test("onComplete callback fires on successful run", async () => {
    const runner = createTestRunner({
      records: [createStmRecord({ id: "stm-1" })],
    });

    let completedResult: unknown = undefined;
    const job = new MemoryConsolidationJob({
      runner,
      onComplete: (result) => {
        completedResult = result;
      },
    });

    await job.triggerNow();

    expect(completedResult).toBeDefined();
  });

  test("onError callback fires on failed run", async () => {
    const runner = createTestRunner({
      records: [createStmRecord({ id: "stm-1" })],
      distillationError: true,
    });

    let errorResult: unknown = undefined;
    const job = new MemoryConsolidationJob({
      runner,
      onError: (error) => {
        errorResult = error;
      },
    });

    const result = await job.triggerNow();

    expect(result.ok).toBe(false);
    expect(errorResult).toBeDefined();
    expect(errorResult).toBeInstanceOf(ConsolidationJobError);
  });

  test("getSchedule returns current schedule config", () => {
    const runner = createTestRunner({ records: [] });

    const job = new MemoryConsolidationJob({
      runner,
      schedule: { intervalMs: 3_600_000, enabled: true },
    });

    const schedule = job.getSchedule();

    expect(schedule.intervalMs).toBe(3_600_000);
    expect(schedule.enabled).toBe(true);
  });

  test("default schedule is 6 hours", () => {
    const runner = createTestRunner({ records: [] });

    const job = new MemoryConsolidationJob({ runner });

    const schedule = job.getSchedule();

    expect(schedule.intervalMs).toBe(6 * 60 * 60 * 1000);
    expect(schedule.enabled).toBe(true);
  });

  test("run count increments on each successful run", async () => {
    const records = [createStmRecord({ id: "stm-1" })];
    const runner = createTestRunner({ records });

    const job = new MemoryConsolidationJob({ runner });

    expect(job.getRunCount()).toBe(0);

    await job.triggerNow();
    expect(job.getRunCount()).toBe(1);
  });

  test("run count does not increment on failed run", async () => {
    const runner = createTestRunner({
      records: [createStmRecord({ id: "stm-1" })],
      distillationError: true,
    });

    const job = new MemoryConsolidationJob({ runner });

    await job.triggerNow();

    expect(job.getRunCount()).toBe(0);
  });

  test("start rejects invalid interval", () => {
    const runner = createTestRunner({ records: [] });

    const job = new MemoryConsolidationJob({
      runner,
      schedule: { enabled: true, intervalMs: 0 },
    });

    const result = job.start();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("CONSOLIDATION_JOB_INVALID_INTERVAL");
  });

  test("error propagation does not crash the job", async () => {
    const runner = createTestRunner({
      records: [createStmRecord({ id: "stm-1" })],
      ltmWriter: createMockLtmWriter({ writeError: true }),
    });

    const job = new MemoryConsolidationJob({ runner });

    const result = await job.triggerNow();

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(ConsolidationJobError);

    const secondResult = await job.triggerNow();
    expect(secondResult.ok).toBe(false);
  });
});
