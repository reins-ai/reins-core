import { describe, expect, test } from "bun:test";

import { ok } from "../../src/result";
import { CronScheduler } from "../../src/cron/scheduler";
import type { CronStore } from "../../src/cron/store";
import type { CronJobDefinition, CronResult } from "../../src/cron/types";

/**
 * In-memory CronStore for fast, filesystem-free restart tests.
 */
class InMemoryCronStore implements CronStore {
  private readonly data = new Map<string, CronJobDefinition>();

  async save(job: CronJobDefinition): Promise<CronResult<void>> {
    this.data.set(job.id, structuredClone(job));
    return ok(undefined);
  }

  async get(id: string): Promise<CronResult<CronJobDefinition | null>> {
    const job = this.data.get(id);
    return ok(job ? structuredClone(job) : null);
  }

  async list(): Promise<CronResult<CronJobDefinition[]>> {
    return ok([...this.data.values()].map((j) => structuredClone(j)));
  }

  async delete(id: string): Promise<CronResult<void>> {
    this.data.delete(id);
    return ok(undefined);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("CronScheduler restart persistence", () => {
  test("re-registers persisted jobs on start()", async () => {
    const store = new InMemoryCronStore();
    let current = new Date("2026-02-11T09:00:00.000Z");

    // Phase 1: Create a scheduler, add a job, then stop (simulates shutdown)
    const first = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async () => {},
    });

    await first.start();
    const created = await first.create({
      id: "restart-job",
      name: "survives restart",
      schedule: "* * * * *",
      payload: { action: "test_action", parameters: { key: "value" } },
    });
    expect(created.ok).toBe(true);
    await first.stop();

    // Phase 2: Create a NEW scheduler instance pointing to the same store
    const executed: string[] = [];
    const second = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async (job) => {
        executed.push(job.id);
      },
    });

    // Phase 3: Start the new instance — it should load persisted jobs
    await second.start();

    // Advance time so the job becomes due
    current = new Date("2026-02-11T09:01:00.000Z");
    await sleep(150);

    // Phase 4: Verify the job was picked up and executed
    expect(executed).toContain("restart-job");
    await second.stop();
  });

  test("does not create duplicate jobs after restart", async () => {
    const store = new InMemoryCronStore();
    let current = new Date("2026-02-11T09:00:00.000Z");

    // Create a scheduler and add a job
    const first = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async () => {},
    });

    await first.start();
    await first.create({
      id: "unique-job",
      name: "no duplicates",
      schedule: "* * * * *",
      payload: { action: "noop", parameters: {} },
    });
    await first.stop();

    // Create a new scheduler and start it twice
    const executed: string[] = [];
    const second = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async (job) => {
        executed.push(job.id);
      },
    });

    await second.start();
    await second.stop();
    await second.start();

    // Advance time so the job becomes due
    current = new Date("2026-02-11T09:01:00.000Z");
    await sleep(150);

    // The job should fire exactly once per tick, not twice (no duplicate)
    expect(executed).toHaveLength(1);
    expect(executed[0]).toBe("unique-job");

    // Verify the store still has exactly one job
    const listed = await store.list();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      const matching = listed.value.filter((j) => j.id === "unique-job");
      expect(matching).toHaveLength(1);
    }

    await second.stop();
  });

  test("multiple jobs all survive restart", async () => {
    const store = new InMemoryCronStore();
    let current = new Date("2026-02-11T09:00:00.000Z");

    // Create a scheduler and add three jobs
    const first = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async () => {},
    });

    await first.start();
    await first.create({
      id: "job-alpha",
      name: "alpha",
      schedule: "* * * * *",
      payload: { action: "alpha_action", parameters: {} },
    });
    await first.create({
      id: "job-beta",
      name: "beta",
      schedule: "* * * * *",
      payload: { action: "beta_action", parameters: {} },
    });
    await first.create({
      id: "job-gamma",
      name: "gamma",
      schedule: "* * * * *",
      payload: { action: "gamma_action", parameters: {} },
    });
    await first.stop();

    // Simulate restart with a new scheduler instance
    const executed: string[] = [];
    const second = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async (job) => {
        executed.push(job.id);
      },
    });

    await second.start();
    current = new Date("2026-02-11T09:01:00.000Z");
    await sleep(150);

    // All three jobs should have fired
    expect(executed).toHaveLength(3);
    expect(executed.sort()).toEqual(["job-alpha", "job-beta", "job-gamma"]);
    await second.stop();
  });

  test("paused jobs are loaded but not executed after restart", async () => {
    const store = new InMemoryCronStore();
    let current = new Date("2026-02-11T09:00:00.000Z");

    // Create a scheduler, add a job, then pause it
    const first = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async () => {},
    });

    await first.start();
    const created = await first.create({
      id: "paused-job",
      name: "will be paused",
      schedule: "* * * * *",
      payload: { action: "noop", parameters: {} },
    });
    expect(created.ok).toBe(true);

    await first.update("paused-job", { status: "paused" });
    await first.stop();

    // Restart with a new scheduler
    const executed: string[] = [];
    const second = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async (job) => {
        executed.push(job.id);
      },
    });

    await second.start();
    current = new Date("2026-02-11T09:01:00.000Z");
    await sleep(150);

    // Paused job should NOT have been executed
    expect(executed).toHaveLength(0);

    // But the job should still be in the store
    const loaded = await second.getJob("paused-job");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value).not.toBeNull();
      expect(loaded.value?.status).toBe("paused");
    }

    await second.stop();
  });

  test("completed jobs are loaded but not re-executed after restart", async () => {
    const store = new InMemoryCronStore();
    let current = new Date("2026-02-11T09:00:00.000Z");

    // Create a scheduler with a maxRuns=1 job, execute it, then stop
    const first = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async () => {},
    });

    await first.start();
    await first.create({
      id: "one-shot",
      name: "runs once",
      schedule: "* * * * *",
      maxRuns: 1,
      payload: { action: "noop", parameters: {} },
    });

    // Advance time to trigger execution
    current = new Date("2026-02-11T09:01:00.000Z");
    await sleep(150);
    await first.stop();

    // Verify the job completed
    const afterFirst = await store.get("one-shot");
    expect(afterFirst.ok).toBe(true);
    if (afterFirst.ok) {
      expect(afterFirst.value?.status).toBe("completed");
      expect(afterFirst.value?.runCount).toBe(1);
    }

    // Restart with a new scheduler
    const executed: string[] = [];
    const second = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async (job) => {
        executed.push(job.id);
      },
    });

    await second.start();
    current = new Date("2026-02-11T09:02:00.000Z");
    await sleep(150);

    // Completed job should NOT be re-executed
    expect(executed).toHaveLength(0);
    await second.stop();
  });

  test("job payload and metadata are preserved across restart", async () => {
    const store = new InMemoryCronStore();
    const current = new Date("2026-02-11T09:00:00.000Z");

    // Create a job with specific payload and tags
    const first = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async () => {},
    });

    await first.start();
    await first.create({
      id: "metadata-job",
      name: "has metadata",
      schedule: "0 9 * * *",
      payload: {
        action: "send_briefing",
        parameters: { channel: "email", priority: "high" },
      },
      tags: ["briefing", "daily"],
    });
    await first.stop();

    // Restart with a new scheduler
    const second = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async () => {},
    });

    await second.start();

    const loaded = await second.getJob("metadata-job");
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.value).not.toBeNull();
      expect(loaded.value?.name).toBe("has metadata");
      expect(loaded.value?.schedule).toBe("0 9 * * *");
      expect(loaded.value?.payload.action).toBe("send_briefing");
      expect(loaded.value?.payload.parameters).toEqual({
        channel: "email",
        priority: "high",
      });
      expect(loaded.value?.tags).toEqual(["briefing", "daily"]);
    }

    await second.stop();
  });

  test("start() is idempotent — calling it while running is a no-op", async () => {
    const store = new InMemoryCronStore();
    let current = new Date("2026-02-11T09:00:00.000Z");

    const executed: string[] = [];
    const scheduler = new CronScheduler({
      store,
      tickIntervalMs: 50,
      now: () => current,
      onExecute: async (job) => {
        executed.push(job.id);
      },
    });

    await scheduler.create({
      id: "idempotent-job",
      name: "idempotent test",
      schedule: "* * * * *",
      payload: { action: "noop", parameters: {} },
    });

    // Start twice while already running
    await scheduler.start();
    await scheduler.start();

    current = new Date("2026-02-11T09:01:00.000Z");
    await sleep(150);

    // Job should fire exactly once, not twice
    expect(executed).toHaveLength(1);
    await scheduler.stop();
  });
});
