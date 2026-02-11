import { describe, expect, test } from "bun:test";

import { CronScheduler } from "../../src/cron/scheduler";
import {
  evaluateCronPolicy,
  isBillingAction,
  isRecursiveCronAction,
} from "../../src/cron/policy";
import type { CronJobDefinition } from "../../src/cron/types";
import type { CronStore } from "../../src/cron/store";
import { ok } from "../../src/result";
import { PERMISSION_DESCRIPTIONS } from "../../src/plugins/permissions";
import type { PluginPermission } from "../../src/types";
import { ScheduleTool } from "../../src/tools/schedule";

class InMemoryCronStore implements CronStore {
  private readonly jobs = new Map<string, CronJobDefinition>();

  async save(job: CronJobDefinition) {
    this.jobs.set(job.id, structuredClone(job));
    return ok(undefined);
  }

  async get(id: string) {
    const job = this.jobs.get(id) ?? null;
    return ok(job ? structuredClone(job) : null);
  }

  async list() {
    return ok(Array.from(this.jobs.values(), (job) => structuredClone(job)));
  }

  async delete(id: string) {
    this.jobs.delete(id);
    return ok(undefined);
  }
}

function createTool(onApprovalRequired?: (job: { action: string; reason: string }) => Promise<boolean>) {
  const scheduler = new CronScheduler({
    store: new InMemoryCronStore(),
    onExecute: async () => {},
    now: () => new Date("2026-02-11T10:00:00.000Z"),
  });

  return new ScheduleTool(scheduler, onApprovalRequired);
}

describe("cron policy", () => {
  test("evaluateCronPolicy allows normal actions without approval", () => {
    const result = evaluateCronPolicy({
      action: "send_notification",
      parameters: { channel: "email" },
    });

    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
  });

  test("evaluateCronPolicy requires approval for billing actions", () => {
    const result = evaluateCronPolicy({
      action: "make_payment",
      parameters: { amount: 100 },
    });

    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.reason).toContain("approval");
  });

  test("evaluateCronPolicy requires approval for recursive cron actions", () => {
    const result = evaluateCronPolicy({
      action: "schedule_cron",
      parameters: { schedule: "0 * * * *" },
    });

    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.reason).toContain("cron");
  });

  test("isRecursiveCronAction identifies recursive actions", () => {
    expect(isRecursiveCronAction("schedule")).toBe(true);
    expect(isRecursiveCronAction("create_schedule")).toBe(true);
    expect(isRecursiveCronAction("schedule_cron")).toBe(true);
    expect(isRecursiveCronAction("notify")).toBe(false);
  });

  test("isBillingAction identifies billing actions", () => {
    expect(isBillingAction("spend_credits")).toBe(true);
    expect(isBillingAction("make_payment")).toBe(true);
    expect(isBillingAction("monthly_billing_reconcile")).toBe(true);
    expect(isBillingAction("purchase_item")).toBe(true);
    expect(isBillingAction("send_notification")).toBe(false);
  });
});

describe("ScheduleTool", () => {
  test("create works for normal actions", async () => {
    const tool = createTool();
    const created = await tool.execute({
      action: "create",
      name: "daily-status",
      schedule: "0 9 * * *",
      taskAction: "send_report",
      taskParameters: { report: "status" },
    });

    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.success).toBe(true);
      expect(created.value.policyCheck?.requiresApproval).toBe(false);
      expect(created.value.job?.name).toBe("daily-status");
    }
  });

  test("create calls approval callback for billing actions", async () => {
    let callbackCalls = 0;
    const tool = createTool(async (job) => {
      callbackCalls += 1;
      return job.action === "make_payment";
    });

    const created = await tool.execute({
      action: "create",
      name: "billing-job",
      schedule: "0 0 * * *",
      taskAction: "make_payment",
      taskParameters: { amount: 25 },
    });

    expect(callbackCalls).toBe(1);
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect(created.value.policyCheck?.requiresApproval).toBe(true);
      expect(created.value.success).toBe(true);
    }
  });

  test("create rejects when approval is denied", async () => {
    const tool = createTool(async () => false);

    const created = await tool.execute({
      action: "create",
      name: "billing-denied",
      schedule: "0 0 * * *",
      taskAction: "purchase",
      taskParameters: { sku: "pro-plan" },
    });

    expect(created.ok).toBe(false);
    if (!created.ok) {
      expect(created.error.code).toBe("CRON_APPROVAL_DENIED");
    }
  });

  test("update, delete, list, get, pause, and resume work", async () => {
    const tool = createTool();

    const created = await tool.execute({
      action: "create",
      name: "ops-job",
      schedule: "*/5 * * * *",
      taskAction: "notify",
      taskParameters: { channel: "slack" },
    });

    expect(created.ok).toBe(true);
    if (!created.ok || !created.value.job) {
      return;
    }

    const jobId = created.value.job.id;

    const fetched = await tool.execute({ action: "get", jobId });
    expect(fetched.ok).toBe(true);
    if (fetched.ok) {
      expect(fetched.value.success).toBe(true);
      expect(fetched.value.job?.id).toBe(jobId);
    }

    const listed = await tool.execute({ action: "list" });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.value.success).toBe(true);
      expect(listed.value.jobs?.length).toBe(1);
    }

    const paused = await tool.execute({ action: "pause", jobId });
    expect(paused.ok).toBe(true);
    if (paused.ok) {
      expect(paused.value.job?.status).toBe("paused");
    }

    const resumed = await tool.execute({ action: "resume", jobId });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) {
      expect(resumed.value.job?.status).toBe("active");
    }

    const updated = await tool.execute({
      action: "update",
      jobId,
      description: "updated description",
      taskAction: "notify",
      taskParameters: { channel: "email" },
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.value.job?.description).toBe("updated description");
      expect(updated.value.job?.payload.parameters).toEqual({ channel: "email" });
    }

    const deleted = await tool.execute({ action: "delete", jobId });
    expect(deleted.ok).toBe(true);
    if (deleted.ok) {
      expect(deleted.value.success).toBe(true);
    }

    const missing = await tool.execute({ action: "get", jobId });
    expect(missing.ok).toBe(true);
    if (missing.ok) {
      expect(missing.value.success).toBe(false);
    }
  });
});

describe("plugin cron permissions", () => {
  test("PluginPermission includes schedule_cron and admin_cron", () => {
    const schedulePermission: PluginPermission = "schedule_cron";
    const adminPermission: PluginPermission = "admin_cron";

    expect(schedulePermission).toBe("schedule_cron");
    expect(adminPermission).toBe("admin_cron");
  });

  test("permission descriptions exist for new cron permissions", () => {
    expect(PERMISSION_DESCRIPTIONS.schedule_cron).toContain("scheduled cron jobs");
    expect(PERMISSION_DESCRIPTIONS.admin_cron).toContain("scheduling policies");
  });
});
