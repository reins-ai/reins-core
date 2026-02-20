import { describe, expect, it } from "bun:test";

import { ScheduleTool } from "../../src/tools/schedule";
import type { ScheduleToolResult } from "../../src/tools/schedule";
import type { CronScheduler } from "../../src/cron/scheduler";
import type { CronJobCreateInput, CronJobDefinition, CronJobUpdateInput } from "../../src/cron/types";
import { CronError } from "../../src/cron/types";
import { ok, type Result } from "../../src/result";

function createTestJob(schedule: string, overrides?: Partial<CronJobDefinition>): CronJobDefinition {
  const now = new Date().toISOString();
  return {
    id: overrides?.id ?? "job-1",
    name: overrides?.name ?? "test-job",
    description: overrides?.description ?? "",
    schedule,
    timezone: overrides?.timezone ?? "UTC",
    status: overrides?.status ?? "active",
    createdBy: "agent",
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    maxRuns: null,
    payload: overrides?.payload ?? { action: "test_action", parameters: {} },
    tags: overrides?.tags ?? [],
  };
}

function createMockScheduler(
  overrides?: Partial<CronScheduler>,
): CronScheduler & { lastCreateInput?: CronJobCreateInput; lastUpdateInput?: CronJobUpdateInput } {
  const mock = {
    lastCreateInput: undefined as CronJobCreateInput | undefined,
    lastUpdateInput: undefined as CronJobUpdateInput | undefined,
    async create(input: CronJobCreateInput) {
      mock.lastCreateInput = input;
      if (overrides?.create) {
        return (overrides.create as (input: CronJobCreateInput) => Promise<Result<CronJobDefinition, CronError>>)(input);
      }
      return ok(createTestJob(input.schedule, { name: input.name }));
    },
    async update(id: string, input: CronJobUpdateInput) {
      mock.lastUpdateInput = input;
      if (overrides?.update) {
        return (overrides.update as (id: string, input: CronJobUpdateInput) => Promise<Result<CronJobDefinition, CronError>>)(id, input);
      }
      return ok(createTestJob(input.schedule ?? "* * * * *", { id }));
    },
    async remove(_id: string) {
      return ok(undefined as void);
    },
    async getJob(id: string) {
      if (overrides?.getJob) {
        return (overrides.getJob as (id: string) => Promise<Result<CronJobDefinition | null, CronError>>)(id);
      }
      return ok(createTestJob("* * * * *", { id }));
    },
    async listJobs() {
      return ok([] as CronJobDefinition[]);
    },
    async start() {
      return ok(undefined as void);
    },
    async stop() {
      return ok(undefined as void);
    },
  } as unknown as CronScheduler & { lastCreateInput?: CronJobCreateInput; lastUpdateInput?: CronJobUpdateInput };

  return mock;
}

describe("ScheduleTool", () => {
  describe("NL schedule parsing", () => {
    it("creates job with 'every weekday morning' NL schedule", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        name: "standup-reminder",
        schedule: "every weekday morning",
        taskAction: "send_notification",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.success).toBe(true);
        expect(result.value.message).toStartWith("Schedule created.");
        expect(result.value.message).toContain("I'll do this every weekday morning");
        expect(result.value.message).toContain("Say 'cancel task' to stop it.");
      }
      expect(scheduler.lastCreateInput?.schedule).toBe("0 8 * * 1-5");
    });

    it("creates job with 'daily at midnight' NL schedule", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        name: "nightly-cleanup",
        schedule: "daily at midnight",
        taskAction: "run_cleanup",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.success).toBe(true);
      }
      expect(scheduler.lastCreateInput?.schedule).toBe("0 0 * * *");
    });

    it("passes raw cron expressions through unchanged", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        name: "custom-cron",
        schedule: "0 9 * * 1",
        taskAction: "weekly_report",
      });

      expect(result.ok).toBe(true);
      expect(scheduler.lastCreateInput?.schedule).toBe("0 9 * * 1");
    });

    it("returns error for unrecognized NL schedule string", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        name: "bad-schedule",
        schedule: "whenever the moon is full",
        taskAction: "howl",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toBe(
          "Could not parse schedule: 'whenever the moon is full'. Please use a cron expression or a recognized time phrase.",
        );
        expect(result.error.code).toBe("CRON_TOOL_SCHEDULE_PARSE_FAILED");
      }
    });

    it("returns error for one-time NL phrase used as schedule", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        name: "once-only",
        schedule: "tomorrow at 3pm",
        taskAction: "send_email",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("Could not parse schedule:");
        expect(result.error.code).toBe("CRON_TOOL_SCHEDULE_PARSE_FAILED");
      }
    });

    it("includes low-confidence note in message", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        name: "biweekly-check",
        schedule: "every other monday",
        taskAction: "run_check",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.message).toContain("Note: I interpreted this as");
        expect(result.value.message).toContain("let me know if that's wrong.");
      }
    });

    it("resolves NL schedule in update action", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "update",
        jobId: "job-1",
        schedule: "every morning",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.success).toBe(true);
      }
      expect(scheduler.lastUpdateInput?.schedule).toBe("0 8 * * *");
    });
  });

  describe("existing behavior", () => {
    it("creates job with raw cron and all fields", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        name: "full-job",
        description: "A fully specified job",
        schedule: "*/5 * * * *",
        timezone: "America/New_York",
        taskAction: "ping",
        taskParameters: { url: "https://example.com" },
        maxRuns: 10,
        tags: ["monitoring"],
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.success).toBe(true);
        expect(result.value.message).toBe("Schedule created");
      }
      expect(scheduler.lastCreateInput?.schedule).toBe("*/5 * * * *");
      expect(scheduler.lastCreateInput?.name).toBe("full-job");
      expect(scheduler.lastCreateInput?.timezone).toBe("America/New_York");
    });

    it("returns error when name is missing", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        schedule: "* * * * *",
        taskAction: "test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CRON_TOOL_NAME_REQUIRED");
      }
    });

    it("returns error when schedule is missing", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        name: "no-schedule",
        taskAction: "test",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CRON_TOOL_SCHEDULE_REQUIRED");
      }
    });

    it("returns error when taskAction is missing", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({
        action: "create",
        name: "no-action",
        schedule: "* * * * *",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CRON_TOOL_ACTION_REQUIRED");
      }
    });

    it("lists jobs", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({ action: "list" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.message).toBe("Schedules listed");
        expect(result.value.jobs).toBeDefined();
      }
    });

    it("gets a job by id", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({ action: "get", jobId: "job-1" });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.message).toBe("Schedule fetched");
        expect(result.value.job).toBeDefined();
      }
    });

    it("returns error for unknown action", async () => {
      const scheduler = createMockScheduler();
      const tool = new ScheduleTool(scheduler);

      const result = await tool.execute({ action: "explode" as "create" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("CRON_UNKNOWN_ACTION");
      }
    });
  });
});
