import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CronExecutor, InMemoryCronAuditLog } from "../../src/cron/executor";
import { CronRateLimiter } from "../../src/cron/rate-limit";
import { CronScheduler } from "../../src/cron/scheduler";
import { LocalCronStore } from "../../src/cron/store";
import type { CronJobDefinition } from "../../src/cron/types";

function createJob(overrides?: Partial<CronJobDefinition>): CronJobDefinition {
  const baseTimestamp = "2026-02-11T10:00:00.000Z";

  return {
    id: overrides?.id ?? crypto.randomUUID(),
    name: overrides?.name ?? "cron-job",
    description: overrides?.description ?? "cron description",
    schedule: overrides?.schedule ?? "* * * * *",
    timezone: overrides?.timezone ?? "UTC",
    status: overrides?.status ?? "active",
    createdBy: overrides?.createdBy ?? "agent",
    createdAt: overrides?.createdAt ?? baseTimestamp,
    updatedAt: overrides?.updatedAt ?? baseTimestamp,
    lastRunAt: overrides?.lastRunAt ?? null,
    nextRunAt: overrides?.nextRunAt ?? "2026-02-11T10:01:00.000Z",
    runCount: overrides?.runCount ?? 0,
    maxRuns: overrides?.maxRuns ?? null,
    payload: overrides?.payload ?? {
      action: "tool.execute",
      parameters: { task: "default" },
    },
    tags: overrides?.tags ?? ["integration"],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CronRateLimiter", () => {
  test("tryAcquire succeeds under configured limits", () => {
    const limiter = new CronRateLimiter({
      maxExecutionsPerMinute: 2,
      maxExecutionsPerHour: 4,
    });

    const first = limiter.tryAcquire(1_000);
    const second = limiter.tryAcquire(2_000);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(limiter.getUsage(2_000)).toEqual({
      minuteCount: 2,
      hourCount: 2,
      minuteLimit: 2,
      hourLimit: 4,
    });
  });

  test("tryAcquire fails when minute limit is exceeded", () => {
    const limiter = new CronRateLimiter({
      maxExecutionsPerMinute: 2,
      maxExecutionsPerHour: 10,
    });

    expect(limiter.tryAcquire(10_000).ok).toBe(true);
    expect(limiter.tryAcquire(20_000).ok).toBe(true);

    const denied = limiter.tryAcquire(30_000);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("CRON_RATE_LIMIT_MINUTE");
    }
  });

  test("tryAcquire fails when hour limit is exceeded", () => {
    const limiter = new CronRateLimiter({
      maxExecutionsPerMinute: 10,
      maxExecutionsPerHour: 2,
    });

    expect(limiter.tryAcquire(10_000).ok).toBe(true);
    expect(limiter.tryAcquire(20_000).ok).toBe(true);

    const denied = limiter.tryAcquire(30_000);
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.error.code).toBe("CRON_RATE_LIMIT_HOUR");
    }
  });

  test("window pruning removes entries older than minute and hour boundaries", () => {
    const limiter = new CronRateLimiter({
      maxExecutionsPerMinute: 3,
      maxExecutionsPerHour: 3,
    });

    expect(limiter.tryAcquire(0).ok).toBe(true);
    expect(limiter.tryAcquire(30_000).ok).toBe(true);
    expect(limiter.tryAcquire(3_000_000).ok).toBe(true);

    const usage = limiter.getUsage(3_600_001);
    expect(usage.minuteCount).toBe(0);
    expect(usage.hourCount).toBe(2);
  });

  test("getUsage returns current counters and limits", () => {
    const limiter = new CronRateLimiter({
      maxExecutionsPerMinute: 5,
      maxExecutionsPerHour: 7,
    });

    expect(limiter.tryAcquire(1_000).ok).toBe(true);
    expect(limiter.tryAcquire(2_000).ok).toBe(true);

    expect(limiter.getUsage(2_000)).toEqual({
      minuteCount: 2,
      hourCount: 2,
      minuteLimit: 5,
      hourLimit: 7,
    });
  });

  test("reset clears all tracked execution timestamps", () => {
    const limiter = new CronRateLimiter({
      maxExecutionsPerMinute: 2,
      maxExecutionsPerHour: 2,
    });

    expect(limiter.tryAcquire(1_000).ok).toBe(true);
    expect(limiter.tryAcquire(2_000).ok).toBe(true);
    limiter.reset();

    expect(limiter.getUsage(2_000)).toEqual({
      minuteCount: 0,
      hourCount: 0,
      minuteLimit: 2,
      hourLimit: 2,
    });
    expect(limiter.tryAcquire(2_500).ok).toBe(true);
  });
});

describe("InMemoryCronAuditLog", () => {
  test("records and retrieves entries", () => {
    const log = new InMemoryCronAuditLog();

    log.record({
      timestamp: 1,
      eventType: "cron.created",
      jobId: "job-1",
      jobName: "job one",
      action: "tool.create",
      success: true,
    });

    const entries = log.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.eventType).toBe("cron.created");
  });

  test("filters entries by jobId", () => {
    const log = new InMemoryCronAuditLog();

    log.record({
      timestamp: 1,
      eventType: "cron.created",
      jobId: "job-1",
      jobName: "job one",
      action: "tool.create",
      success: true,
    });
    log.record({
      timestamp: 2,
      eventType: "cron.created",
      jobId: "job-2",
      jobName: "job two",
      action: "tool.create",
      success: true,
    });

    const entries = log.getEntries("job-2");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.jobId).toBe("job-2");
  });

  test("filters entries by eventType", () => {
    const log = new InMemoryCronAuditLog();

    log.record({
      timestamp: 1,
      eventType: "cron.executed",
      jobId: "job-1",
      jobName: "job one",
      action: "tool.execute",
      success: true,
    });
    log.record({
      timestamp: 2,
      eventType: "cron.failed",
      jobId: "job-1",
      jobName: "job one",
      action: "tool.execute",
      success: false,
      error: "boom",
    });

    const failedEntries = log.getEntriesByType("cron.failed");
    expect(failedEntries).toHaveLength(1);
    expect(failedEntries[0]?.error).toBe("boom");
  });

  test("clear removes all entries", () => {
    const log = new InMemoryCronAuditLog();

    log.record({
      timestamp: 1,
      eventType: "cron.created",
      jobId: "job-1",
      jobName: "job one",
      action: "tool.create",
      success: true,
    });

    log.clear();
    expect(log.getEntries()).toHaveLength(0);
  });
});

describe("CronExecutor", () => {
  test("execute records successful execution audit event", async () => {
    const auditLog = new InMemoryCronAuditLog();
    const rateLimiter = new CronRateLimiter({
      maxExecutionsPerMinute: 10,
      maxExecutionsPerHour: 10,
    });

    let now = 10_000;
    const executor = new CronExecutor({
      rateLimiter,
      auditLog,
      now: () => new Date(now),
      handler: async () => {
        now += 25;
      },
    });

    await executor.execute(createJob());

    const entries = auditLog.getEntriesByType("cron.executed");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.success).toBe(true);
    expect(entries[0]?.durationMs).toBe(25);
  });

  test("execute records failed execution audit event", async () => {
    const auditLog = new InMemoryCronAuditLog();
    const rateLimiter = new CronRateLimiter({
      maxExecutionsPerMinute: 10,
      maxExecutionsPerHour: 10,
    });

    let now = 10_000;
    const executor = new CronExecutor({
      rateLimiter,
      auditLog,
      now: () => new Date(now),
      handler: async () => {
        now += 50;
        throw new Error("handler failed");
      },
    });

    await expect(executor.execute(createJob())).rejects.toThrow("handler failed");

    const entries = auditLog.getEntriesByType("cron.failed");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.success).toBe(false);
    expect(entries[0]?.error).toBe("handler failed");
    expect(entries[0]?.durationMs).toBe(50);
  });

  test("execute records rate-limited events", async () => {
    const auditLog = new InMemoryCronAuditLog();
    const rateLimiter = new CronRateLimiter({
      maxExecutionsPerMinute: 1,
      maxExecutionsPerHour: 10,
    });
    const base = 20_000;
    expect(rateLimiter.tryAcquire(base).ok).toBe(true);

    const executor = new CronExecutor({
      rateLimiter,
      auditLog,
      now: () => new Date(base + 1),
      handler: async () => {},
    });

    await expect(executor.execute(createJob())).rejects.toThrow("Rate limit exceeded");

    const entries = auditLog.getEntriesByType("cron.rate_limited");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.success).toBe(false);
  });

  test("multiple executions succeed within rate limits", async () => {
    const auditLog = new InMemoryCronAuditLog();
    const rateLimiter = new CronRateLimiter({
      maxExecutionsPerMinute: 2,
      maxExecutionsPerHour: 2,
    });

    let now = 30_000;
    const executedJobIds: string[] = [];
    const executor = new CronExecutor({
      rateLimiter,
      auditLog,
      now: () => new Date(now),
      handler: async (job) => {
        executedJobIds.push(job.id);
        now += 5;
      },
    });

    const job1 = createJob({ id: "job-1" });
    const job2 = createJob({ id: "job-2" });
    await executor.execute(job1);
    now += 100;
    await executor.execute(job2);

    expect(executedJobIds).toEqual(["job-1", "job-2"]);
    expect(auditLog.getEntriesByType("cron.executed")).toHaveLength(2);
  });

  test("lifecycle methods record create/update/delete/pause/resume events", () => {
    const auditLog = new InMemoryCronAuditLog();
    const executor = new CronExecutor({
      rateLimiter: new CronRateLimiter(),
      auditLog,
      now: () => new Date("2026-02-11T10:00:00.000Z"),
      handler: async () => {},
    });

    const job = createJob({ id: "job-lifecycle", name: "lifecycle-job" });
    executor.logCreated(job);
    executor.logUpdated(job);
    executor.logPaused(job);
    executor.logResumed(job);
    executor.logDeleted(job.id, job.name);

    expect(auditLog.getEntriesByType("cron.created")).toHaveLength(1);
    expect(auditLog.getEntriesByType("cron.updated")).toHaveLength(1);
    expect(auditLog.getEntriesByType("cron.paused")).toHaveLength(1);
    expect(auditLog.getEntriesByType("cron.resumed")).toHaveLength(1);
    expect(auditLog.getEntriesByType("cron.deleted")).toHaveLength(1);
  });
});

describe("integration/cron-agent-flow", () => {
  test("scheduler executes through CronExecutor with audit trail and rate limiting", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-agent-flow-"));

    try {
      const store = new LocalCronStore(dir);
      let current = new Date("2026-02-11T10:00:00.000Z");
      const auditLog = new InMemoryCronAuditLog();
      const executed: string[] = [];

      const executor = new CronExecutor({
        rateLimiter: new CronRateLimiter({
          maxExecutionsPerMinute: 1,
          maxExecutionsPerHour: 10,
        }),
        auditLog,
        now: () => current,
        handler: async (job) => {
          executed.push(job.id);
        },
      });

      const scheduler = new CronScheduler({
        store,
        tickIntervalMs: 50,
        now: () => current,
        onExecute: (job) => executor.execute(job),
      });

      const createdOne = await scheduler.create({
        name: "job-one",
        schedule: "* * * * *",
        payload: { action: "memory.sync", parameters: { source: "cron" } },
      });
      expect(createdOne.ok).toBe(true);
      if (!createdOne.ok) {
        return;
      }

      const createdTwo = await scheduler.create({
        name: "job-two",
        schedule: "* * * * *",
        payload: { action: "memory.sync", parameters: { source: "cron" } },
      });
      expect(createdTwo.ok).toBe(true);
      if (!createdTwo.ok) {
        return;
      }

      executor.logCreated(createdOne.value);
      executor.logCreated(createdTwo.value);

      const started = await scheduler.start();
      expect(started.ok).toBe(true);

      current = new Date("2026-02-11T10:01:00.000Z");
      await sleep(150);
      await scheduler.stop();

      const executedEntries = auditLog.getEntriesByType("cron.executed");
      const rateLimitedEntries = auditLog.getEntriesByType("cron.rate_limited");

      expect(executed).toHaveLength(1);
      expect(executedEntries).toHaveLength(1);
      expect(rateLimitedEntries).toHaveLength(1);

      const allCreated = auditLog.getEntriesByType("cron.created");
      expect(allCreated).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
