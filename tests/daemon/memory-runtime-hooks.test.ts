import { describe, expect, it } from "bun:test";

import { ok, err } from "../../src/result";
import { registerMemoryCronJobs, type MemoryCronHandle } from "../../src/daemon/memory-cron-registration";
import { MemoryConsolidationJob } from "../../src/cron/jobs/memory-consolidation-job";
import { MorningBriefingJob } from "../../src/cron/jobs/morning-briefing-job";
import type { ConsolidationRunner, ConsolidationRunResult } from "../../src/memory/consolidation/consolidation-runner";
import type { MorningBriefingService, Briefing } from "../../src/memory/proactive/morning-briefing-service";

function createStubRunner(): ConsolidationRunner {
  return {
    run: async () => ok({
      runId: "test-run",
      timestamp: new Date(),
      stats: { candidatesProcessed: 0, factsDistilled: 0, created: 0, updated: 0, superseded: 0, skipped: 0 },
      mergeResult: null,
      errors: [],
      durationMs: 0,
    }),
  } as unknown as ConsolidationRunner;
}

function createStubBriefingService(): MorningBriefingService {
  return {
    generateBriefing: async () => ok({
      timestamp: new Date(),
      sections: [],
      totalItems: 0,
      generatedInMs: 0,
    }),
  } as unknown as MorningBriefingService;
}

function createConsolidationJob(): MemoryConsolidationJob {
  return new MemoryConsolidationJob({
    runner: createStubRunner(),
  });
}

function createBriefingJob(): MorningBriefingJob {
  return new MorningBriefingJob({
    service: createStubBriefingService(),
  });
}

describe("memory cron registration", () => {
  it("registers both cron jobs when memory is ready", () => {
    const consolidationJob = createConsolidationJob();
    const briefingJob = createBriefingJob();

    const result = registerMemoryCronJobs({
      consolidationJob,
      briefingJob,
      isMemoryReady: () => true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.isConsolidationRunning()).toBe(true);
      expect(result.value.isBriefingRunning()).toBe(true);
      result.value.stopAll();
    }
  });

  it("rejects cron registration when memory is not ready", () => {
    const consolidationJob = createConsolidationJob();
    const briefingJob = createBriefingJob();

    const result = registerMemoryCronJobs({
      consolidationJob,
      briefingJob,
      isMemoryReady: () => false,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DAEMON_MEMORY_NOT_READY");
    }

    expect(consolidationJob.isRunning()).toBe(false);
    expect(briefingJob.isRunning()).toBe(false);
  });

  it("stops both cron jobs via handle", () => {
    const consolidationJob = createConsolidationJob();
    const briefingJob = createBriefingJob();

    const result = registerMemoryCronJobs({
      consolidationJob,
      briefingJob,
      isMemoryReady: () => true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const handle = result.value;
    expect(handle.isConsolidationRunning()).toBe(true);
    expect(handle.isBriefingRunning()).toBe(true);

    handle.stopAll();

    expect(handle.isConsolidationRunning()).toBe(false);
    expect(handle.isBriefingRunning()).toBe(false);
  });

  it("rolls back consolidation job if briefing job fails to start", () => {
    const consolidationJob = createConsolidationJob();

    // Create a briefing job that is disabled so start() returns an error
    const briefingJob = new MorningBriefingJob({
      service: createStubBriefingService(),
      schedule: { enabled: false },
    });

    const result = registerMemoryCronJobs({
      consolidationJob,
      briefingJob,
      isMemoryReady: () => true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DAEMON_CRON_REGISTRATION_FAILED");
    }

    // Consolidation should have been rolled back
    expect(consolidationJob.isRunning()).toBe(false);
  });

  it("returns error if consolidation job fails to start", () => {
    // Create a consolidation job that is disabled so start() returns an error
    const consolidationJob = new MemoryConsolidationJob({
      runner: createStubRunner(),
      schedule: { enabled: false },
    });
    const briefingJob = createBriefingJob();

    const result = registerMemoryCronJobs({
      consolidationJob,
      briefingJob,
      isMemoryReady: () => true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DAEMON_CRON_REGISTRATION_FAILED");
    }

    expect(consolidationJob.isRunning()).toBe(false);
    expect(briefingJob.isRunning()).toBe(false);
  });

  it("cron jobs are not started before registration", () => {
    const consolidationJob = createConsolidationJob();
    const briefingJob = createBriefingJob();

    expect(consolidationJob.isRunning()).toBe(false);
    expect(briefingJob.isRunning()).toBe(false);
  });

  it("cron registration enforces post-initialization ordering", () => {
    const consolidationJob = createConsolidationJob();
    const briefingJob = createBriefingJob();

    // First call with memory not ready — should fail
    const failResult = registerMemoryCronJobs({
      consolidationJob,
      briefingJob,
      isMemoryReady: () => false,
    });
    expect(failResult.ok).toBe(false);

    // Second call with memory ready — should succeed
    const successResult = registerMemoryCronJobs({
      consolidationJob,
      briefingJob,
      isMemoryReady: () => true,
    });
    expect(successResult.ok).toBe(true);
    if (successResult.ok) {
      successResult.value.stopAll();
    }
  });
});
