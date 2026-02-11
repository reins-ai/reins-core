import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalCronStore } from "../../src/cron/store";
import { CronScheduler, isJobDue } from "../../src/cron/scheduler";
import type { CronJobDefinition } from "../../src/cron/types";

function createTestJob(overrides?: Partial<CronJobDefinition>): CronJobDefinition {
  const createdAt = "2026-02-11T09:00:00.000Z";

  return {
    id: overrides?.id ?? crypto.randomUUID(),
    name: overrides?.name ?? "test-job",
    description: overrides?.description ?? "test description",
    schedule: overrides?.schedule ?? "* * * * *",
    timezone: overrides?.timezone ?? "UTC",
    status: overrides?.status ?? "active",
    createdBy: overrides?.createdBy ?? "agent",
    createdAt: overrides?.createdAt ?? createdAt,
    updatedAt: overrides?.updatedAt ?? createdAt,
    lastRunAt: overrides?.lastRunAt ?? null,
    nextRunAt: overrides?.nextRunAt ?? "2026-02-11T09:01:00.000Z",
    runCount: overrides?.runCount ?? 0,
    maxRuns: overrides?.maxRuns ?? null,
    payload: overrides?.payload ?? {
      action: "test_action",
      parameters: { value: 1 },
    },
    tags: overrides?.tags ?? ["test"],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("LocalCronStore", () => {
  test("save and retrieve a job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-store-"));

    try {
      const store = new LocalCronStore(dir);
      const job = createTestJob();

      const saved = await store.save(job);
      expect(saved.ok).toBe(true);

      const fetched = await store.get(job.id);
      expect(fetched.ok).toBe(true);
      if (fetched.ok) {
        expect(fetched.value).not.toBeNull();
        expect(fetched.value?.id).toBe(job.id);
        expect(fetched.value?.name).toBe(job.name);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("list all jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-store-"));

    try {
      const store = new LocalCronStore(dir);
      const first = createTestJob({ name: "first" });
      const second = createTestJob({ name: "second" });

      await store.save(first);
      await store.save(second);

      const listed = await store.list();
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toHaveLength(2);
        const names = listed.value.map((job) => job.name).sort();
        expect(names).toEqual(["first", "second"]);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("delete a job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-store-"));

    try {
      const store = new LocalCronStore(dir);
      const job = createTestJob();

      await store.save(job);
      const deleted = await store.delete(job.id);
      expect(deleted.ok).toBe(true);

      const fetched = await store.get(job.id);
      expect(fetched.ok).toBe(true);
      if (fetched.ok) {
        expect(fetched.value).toBeNull();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("get non-existent job returns null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-store-"));

    try {
      const store = new LocalCronStore(dir);
      const result = await store.get("missing-job");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("save updates existing job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-store-"));

    try {
      const store = new LocalCronStore(dir);
      const job = createTestJob({ name: "original" });
      await store.save(job);

      const updated = { ...job, name: "updated", runCount: 2 };
      await store.save(updated);

      const fetched = await store.get(job.id);
      expect(fetched.ok).toBe(true);
      if (fetched.ok) {
        expect(fetched.value?.name).toBe("updated");
        expect(fetched.value?.runCount).toBe(2);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isJobDue", () => {
  test("matches every minute with * * * * *", () => {
    const job = createTestJob({ schedule: "* * * * *" });
    const when = new Date("2026-02-11T09:37:00.000Z");
    expect(isJobDue(job, when)).toBe(true);
  });

  test("matches only 9 AM daily with 0 9 * * *", () => {
    const job = createTestJob({ schedule: "0 9 * * *" });
    expect(isJobDue(job, new Date("2026-02-11T09:00:00.000Z"))).toBe(true);
    expect(isJobDue(job, new Date("2026-02-11T09:01:00.000Z"))).toBe(false);
    expect(isJobDue(job, new Date("2026-02-11T08:00:00.000Z"))).toBe(false);
  });

  test("matches every 5 minutes with */5 * * * *", () => {
    const job = createTestJob({ schedule: "*/5 * * * *" });
    expect(isJobDue(job, new Date("2026-02-11T09:00:00.000Z"))).toBe(true);
    expect(isJobDue(job, new Date("2026-02-11T09:05:00.000Z"))).toBe(true);
    expect(isJobDue(job, new Date("2026-02-11T09:10:00.000Z"))).toBe(true);
    expect(isJobDue(job, new Date("2026-02-11T09:11:00.000Z"))).toBe(false);
  });

  test("matches weekdays at 9 AM with 0 9 * * 1-5", () => {
    const job = createTestJob({ schedule: "0 9 * * 1-5" });
    expect(isJobDue(job, new Date("2026-02-09T09:00:00.000Z"))).toBe(true);
    expect(isJobDue(job, new Date("2026-02-13T09:00:00.000Z"))).toBe(true);
    expect(isJobDue(job, new Date("2026-02-14T09:00:00.000Z"))).toBe(false);
    expect(isJobDue(job, new Date("2026-02-15T09:00:00.000Z"))).toBe(false);
  });
});

describe("CronScheduler", () => {
  test("create job persists it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-scheduler-"));

    try {
      const store = new LocalCronStore(dir);
      let current = new Date("2026-02-11T09:00:00.000Z");
      const scheduler = new CronScheduler({
        store,
        onExecute: async () => {},
        now: () => current,
      });

      const created = await scheduler.create({
        name: "persisted",
        schedule: "* * * * *",
        payload: { action: "noop", parameters: {} },
      });

      expect(created.ok).toBe(true);
      if (created.ok) {
        const loaded = await store.get(created.value.id);
        expect(loaded.ok).toBe(true);
        if (loaded.ok) {
          expect(loaded.value?.name).toBe("persisted");
        }
      }

      current = new Date("2026-02-11T09:01:00.000Z");
      void current;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("update job name and schedule", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-scheduler-"));

    try {
      const store = new LocalCronStore(dir);
      const scheduler = new CronScheduler({
        store,
        onExecute: async () => {},
        now: () => new Date("2026-02-11T09:00:00.000Z"),
      });

      const created = await scheduler.create({
        name: "original",
        schedule: "* * * * *",
        payload: { action: "noop", parameters: {} },
      });

      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      const updated = await scheduler.update(created.value.id, {
        name: "renamed",
        schedule: "*/5 * * * *",
      });

      expect(updated.ok).toBe(true);
      if (updated.ok) {
        expect(updated.value.name).toBe("renamed");
        expect(updated.value.schedule).toBe("*/5 * * * *");
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("remove job", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-scheduler-"));

    try {
      const store = new LocalCronStore(dir);
      const scheduler = new CronScheduler({
        store,
        onExecute: async () => {},
        now: () => new Date("2026-02-11T09:00:00.000Z"),
      });

      const created = await scheduler.create({
        name: "to-delete",
        schedule: "* * * * *",
        payload: { action: "noop", parameters: {} },
      });

      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      const removed = await scheduler.remove(created.value.id);
      expect(removed.ok).toBe(true);

      const loaded = await scheduler.getJob(created.value.id);
      expect(loaded.ok).toBe(true);
      if (loaded.ok) {
        expect(loaded.value).toBeNull();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("list jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-scheduler-"));

    try {
      const store = new LocalCronStore(dir);
      const scheduler = new CronScheduler({
        store,
        onExecute: async () => {},
        now: () => new Date("2026-02-11T09:00:00.000Z"),
      });

      await scheduler.create({
        name: "one",
        schedule: "* * * * *",
        payload: { action: "noop", parameters: {} },
      });
      await scheduler.create({
        name: "two",
        schedule: "*/5 * * * *",
        payload: { action: "noop", parameters: {} },
      });

      const listed = await scheduler.listJobs();
      expect(listed.ok).toBe(true);
      if (listed.ok) {
        expect(listed.value).toHaveLength(2);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("executes due job when scheduler is running", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-scheduler-"));

    try {
      const store = new LocalCronStore(dir);
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

      const created = await scheduler.create({
        name: "run-once",
        schedule: "* * * * *",
        payload: { action: "noop", parameters: {} },
      });

      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      await scheduler.start();
      current = new Date("2026-02-11T09:01:00.000Z");

      await sleep(120);
      expect(executed).toHaveLength(1);
      await scheduler.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("job with maxRuns=1 completes after one run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-scheduler-"));

    try {
      const store = new LocalCronStore(dir);
      let current = new Date("2026-02-11T09:00:00.000Z");
      const scheduler = new CronScheduler({
        store,
        tickIntervalMs: 50,
        now: () => current,
        onExecute: async () => {},
      });

      const created = await scheduler.create({
        name: "max-runs",
        schedule: "* * * * *",
        maxRuns: 1,
        payload: { action: "noop", parameters: {} },
      });

      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      await scheduler.start();
      current = new Date("2026-02-11T09:01:00.000Z");

      await sleep(120);
      const after = await scheduler.getJob(created.value.id);
      expect(after.ok).toBe(true);
      if (after.ok) {
        expect(after.value?.status).toBe("completed");
        expect(after.value?.runCount).toBe(1);
      }

      await scheduler.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("paused job is not executed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-scheduler-"));

    try {
      const store = new LocalCronStore(dir);
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

      const created = await scheduler.create({
        name: "paused",
        schedule: "* * * * *",
        payload: { action: "noop", parameters: {} },
      });

      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      await scheduler.update(created.value.id, { status: "paused" });

      await scheduler.start();
      current = new Date("2026-02-11T09:01:00.000Z");
      await sleep(120);

      expect(executed).toHaveLength(0);
      await scheduler.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("stop prevents further execution", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-scheduler-"));

    try {
      const store = new LocalCronStore(dir);
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
        name: "stop-test",
        schedule: "* * * * *",
        payload: { action: "noop", parameters: {} },
      });

      await scheduler.start();
      await scheduler.stop();

      current = new Date("2026-02-11T09:01:00.000Z");
      await sleep(120);

      expect(executed).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("boot restore loads existing jobs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-cron-scheduler-"));

    try {
      const store = new LocalCronStore(dir);
      let current = new Date("2026-02-11T09:00:00.000Z");

      const writer = new CronScheduler({
        store,
        onExecute: async () => {},
        now: () => current,
      });

      const created = await writer.create({
        name: "restored",
        schedule: "* * * * *",
        payload: { action: "noop", parameters: {} },
      });

      expect(created.ok).toBe(true);
      if (!created.ok) {
        return;
      }

      const executed: string[] = [];
      const reader = new CronScheduler({
        store,
        tickIntervalMs: 50,
        now: () => current,
        onExecute: async (job) => {
          executed.push(job.id);
        },
      });

      await reader.start();
      current = new Date("2026-02-11T09:01:00.000Z");
      await sleep(120);

      expect(executed).toContain(created.value.id);
      await reader.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
