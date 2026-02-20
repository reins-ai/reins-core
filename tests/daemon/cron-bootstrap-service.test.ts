import { describe, expect, test } from "bun:test";

import { err, ok } from "../../src/result";
import {
  CronBootstrapService,
  DEFAULT_HEARTBEAT_SCHEDULE,
  DEFAULT_MORNING_BRIEFING_SCHEDULE,
  MORNING_BRIEFING_JOB_ACTION,
  MORNING_BRIEFING_JOB_ID,
} from "../../src/daemon/cron-bootstrap-service";
import { HEARTBEAT_JOB_ACTION, HEARTBEAT_JOB_ID } from "../../src/cron/jobs/heartbeat-job";
import type { CronJobCreateInput, CronJobDefinition } from "../../src/cron/types";
import { CronError } from "../../src/cron/types";

interface TestLoggerEntry {
  message: string;
  details?: Record<string, unknown>;
}

class TestLogger {
  readonly infos: TestLoggerEntry[] = [];
  readonly errors: TestLoggerEntry[] = [];

  info(message: string, details?: Record<string, unknown>): void {
    this.infos.push({ message, details });
  }

  error(message: string, details?: Record<string, unknown>): void {
    this.errors.push({ message, details });
  }
}

class TestScheduler {
  readonly jobs = new Map<string, CronJobDefinition>();
  startCalls = 0;
  stopCalls = 0;
  startFailure: CronError | null = null;
  createFailureForJobId: string | null = null;
  stopFailure: CronError | null = null;

  async start() {
    this.startCalls += 1;
    if (this.startFailure) {
      return err(this.startFailure);
    }

    return ok(undefined);
  }

  async stop() {
    this.stopCalls += 1;
    if (this.stopFailure) {
      return err(this.stopFailure);
    }

    return ok(undefined);
  }

  async getJob(id: string) {
    return ok(this.jobs.get(id) ?? null);
  }

  async create(input: CronJobCreateInput) {
    if (!input.id) {
      return err(new CronError("Missing id", "TEST_JOB_ID_REQUIRED"));
    }

    if (this.createFailureForJobId === input.id) {
      return err(new CronError(`Failed to create ${input.id}`, "TEST_CREATE_FAILED"));
    }

    const now = new Date("2026-02-20T08:00:00.000Z").toISOString();
    const created: CronJobDefinition = {
      id: input.id,
      name: input.name,
      description: input.description ?? "",
      schedule: input.schedule,
      timezone: input.timezone ?? "UTC",
      status: "active",
      createdBy: "test",
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      maxRuns: input.maxRuns ?? null,
      payload: input.payload,
      tags: input.tags ?? [],
    };

    this.jobs.set(created.id, created);
    return ok(created);
  }
}

describe("CronBootstrapService", () => {
  test("registers default morning briefing and heartbeat jobs", async () => {
    const scheduler = new TestScheduler();
    const logger = new TestLogger();
    const service = new CronBootstrapService({
      scheduler,
      logger,
      timezone: "UTC",
    });

    const result = await service.start();

    expect(result.ok).toBe(true);
    expect(scheduler.startCalls).toBe(1);

    const morning = scheduler.jobs.get(MORNING_BRIEFING_JOB_ID);
    const heartbeat = scheduler.jobs.get(HEARTBEAT_JOB_ID);

    expect(morning?.schedule).toBe(DEFAULT_MORNING_BRIEFING_SCHEDULE);
    expect(morning?.payload.action).toBe(MORNING_BRIEFING_JOB_ACTION);
    expect(heartbeat?.schedule).toBe(DEFAULT_HEARTBEAT_SCHEDULE);
    expect(heartbeat?.payload.action).toBe(HEARTBEAT_JOB_ACTION);

    expect(logger.infos.some((entry) => entry.message === "Cron scheduler initialized")).toBe(true);
  });

  test("returns ok and logs error when bootstrap fails", async () => {
    const scheduler = new TestScheduler();
    scheduler.createFailureForJobId = MORNING_BRIEFING_JOB_ID;
    const logger = new TestLogger();
    const service = new CronBootstrapService({
      scheduler,
      logger,
      timezone: "UTC",
    });

    const result = await service.start();

    expect(result.ok).toBe(true);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.message).toBe("Cron bootstrap failed; continuing daemon startup");
  });

  test("stop cleanly stops scheduler", async () => {
    const scheduler = new TestScheduler();
    const logger = new TestLogger();
    const service = new CronBootstrapService({
      scheduler,
      logger,
      timezone: "UTC",
    });

    await service.start();
    const stopped = await service.stop();

    expect(stopped.ok).toBe(true);
    expect(scheduler.stopCalls).toBe(1);
    expect(logger.infos.some((entry) => entry.message === "Cron scheduler stopped")).toBe(true);
  });

  test("does not re-create jobs when they already exist", async () => {
    const scheduler = new TestScheduler();
    const seededAt = "2026-02-20T07:59:00.000Z";
    scheduler.jobs.set(MORNING_BRIEFING_JOB_ID, {
      id: MORNING_BRIEFING_JOB_ID,
      name: "morning-briefing",
      description: "existing",
      schedule: DEFAULT_MORNING_BRIEFING_SCHEDULE,
      timezone: "UTC",
      status: "active",
      createdBy: "seed",
      createdAt: seededAt,
      updatedAt: seededAt,
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      maxRuns: null,
      payload: { action: MORNING_BRIEFING_JOB_ACTION, parameters: {} },
      tags: ["system"],
    });

    const service = new CronBootstrapService({
      scheduler,
      logger: new TestLogger(),
      timezone: "UTC",
    });

    const result = await service.start();

    expect(result.ok).toBe(true);
    expect(scheduler.jobs.size).toBe(2);
  });
});
