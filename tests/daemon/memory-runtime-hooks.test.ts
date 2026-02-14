import { describe, expect, it } from "bun:test";

import { ok } from "../../src/result";
import { registerMemoryCronJobs } from "../../src/daemon/memory-cron-registration";
import { DaemonHttpServer } from "../../src/daemon/server";
import { MemoryConsolidationJob } from "../../src/cron/jobs/memory-consolidation-job";
import { MorningBriefingJob } from "../../src/cron/jobs/morning-briefing-job";
import type { ConsolidationRunner } from "../../src/memory/consolidation/consolidation-runner";
import type { MorningBriefingService } from "../../src/memory/proactive/morning-briefing-service";
import type { MemoryService, ExplicitMemoryInput, MemoryListOptions } from "../../src/memory/services/memory-service";
import type { MemoryRecord } from "../../src/memory/types/memory-record";
import { ToolExecutor } from "../../src/tools";

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

interface ServerWithToolExecutor {
  toolExecutor: ToolExecutor;
}

class FakeMemoryService {
  private readonly records: MemoryRecord[] = [];
  private ready = true;

  isReady(): boolean {
    return this.ready;
  }

  async rememberExplicit(input: ExplicitMemoryInput) {
    const now = new Date();
    const record: MemoryRecord = {
      id: `memory-${this.records.length + 1}`,
      content: input.content,
      type: input.type ?? "fact",
      layer: "stm",
      tags: input.tags ?? [],
      entities: input.entities ?? [],
      importance: 0.7,
      confidence: 1,
      provenance: {
        sourceType: "explicit",
        conversationId: input.conversationId,
      },
      createdAt: now,
      updatedAt: now,
      accessedAt: now,
    };
    this.records.push(record);
    return ok(record);
  }

  async list(options?: MemoryListOptions) {
    const limit = options?.limit ?? 50;
    return ok(this.records.slice(0, limit));
  }
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

describe("memory tool runtime hooks", () => {
  it("registers memory tool in default executor and supports remember + recall", async () => {
    const memoryService = new FakeMemoryService();
    const server = new DaemonHttpServer({
      memoryService: memoryService as unknown as MemoryService,
    });

    const toolExecutor = (server as unknown as ServerWithToolExecutor).toolExecutor;

    const rememberResult = await toolExecutor.execute(
      {
        id: "tool-call-remember",
        name: "memory",
        arguments: {
          action: "remember",
          content: "User prefers concise responses",
          tags: ["preference"],
        },
      },
      {
        conversationId: "conv-remember",
        userId: "user-1",
      },
    );

    expect(rememberResult.error).toBeUndefined();
    expect((rememberResult.result as { action: string }).action).toBe("remember");

    const recallResult = await toolExecutor.execute(
      {
        id: "tool-call-recall",
        name: "memory",
        arguments: {
          action: "recall",
          query: "concise",
        },
      },
      {
        conversationId: "conv-later",
        userId: "user-1",
      },
    );

    expect(recallResult.error).toBeUndefined();
    const recallPayload = recallResult.result as {
      action: string;
      query: string;
      count: number;
      results: Array<{ content: string; tags: string[] }>;
    };
    expect(recallPayload.action).toBe("recall");
    expect(recallPayload.query).toBe("concise");
    expect(recallPayload.count).toBe(1);
    expect(recallPayload.results[0]?.content).toContain("concise responses");
    expect(recallPayload.results[0]?.tags).toContain("preference");
  });
});
