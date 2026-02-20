import type { CronScheduler } from "../cron/scheduler";
import { evaluateCronPolicy, type CronPolicyResult } from "../cron/policy";
import type { CronJobDefinition, CronJobPayload } from "../cron/types";
import { CronError } from "../cron/types";
import { err, ok, type Result } from "../result";
import { parseNlTime } from "./date-parser";

type ScheduleAction = "create" | "update" | "delete" | "list" | "get" | "pause" | "resume";

export interface ScheduleToolAction {
  action: ScheduleAction;
  name?: string;
  description?: string;
  schedule?: string;
  timezone?: string;
  taskAction?: string;
  taskParameters?: Record<string, unknown>;
  maxRuns?: number | null;
  tags?: string[];
  jobId?: string;
}

export interface ScheduleToolResult {
  success: boolean;
  message: string;
  job?: CronJobDefinition;
  jobs?: CronJobDefinition[];
  policyCheck?: CronPolicyResult;
}

export class ScheduleTool {
  constructor(
    private readonly scheduler: CronScheduler,
    private readonly onApprovalRequired?: (job: { action: string; reason: string }) => Promise<boolean>,
  ) {}

  async execute(action: ScheduleToolAction): Promise<Result<ScheduleToolResult, CronError>> {
    switch (action.action) {
      case "create":
        return this.create(action);
      case "update":
        return this.update(action);
      case "delete":
        return this.delete(action);
      case "list":
        return this.list();
      case "get":
        return this.get(action);
      case "pause":
        return this.pause(action);
      case "resume":
        return this.resume(action);
      default:
        return err(new CronError(`Unknown schedule action: ${action.action}`, "CRON_UNKNOWN_ACTION"));
    }
  }

  private async create(action: ScheduleToolAction): Promise<Result<ScheduleToolResult, CronError>> {
    if (!action.name || action.name.trim().length === 0) {
      return err(new CronError("Schedule create requires a non-empty name", "CRON_TOOL_NAME_REQUIRED"));
    }

    if (!action.schedule || action.schedule.trim().length === 0) {
      return err(new CronError("Schedule create requires a schedule expression", "CRON_TOOL_SCHEDULE_REQUIRED"));
    }

    if (!action.taskAction || action.taskAction.trim().length === 0) {
      return err(new CronError("Schedule create requires a taskAction", "CRON_TOOL_ACTION_REQUIRED"));
    }

    const resolvedSchedule = this.resolveSchedule(action.schedule);
    if (!resolvedSchedule.ok) {
      return resolvedSchedule;
    }

    const payload: CronJobPayload = {
      action: action.taskAction,
      parameters: action.taskParameters ?? {},
    };

    const policyResult = await this.evaluateAndApprove(payload);
    if (!policyResult.ok) {
      return policyResult;
    }

    const created = await this.scheduler.create({
      name: action.name,
      description: action.description,
      schedule: resolvedSchedule.value.cron,
      timezone: action.timezone,
      payload,
      maxRuns: action.maxRuns,
      tags: action.tags,
    });
    if (!created.ok) {
      return created;
    }

    let message = "Schedule created";
    if (resolvedSchedule.value.note) {
      message += `. ${resolvedSchedule.value.note}`;
    }

    return ok({
      success: true,
      message,
      job: created.value,
      policyCheck: policyResult.value,
    });
  }

  private async update(action: ScheduleToolAction): Promise<Result<ScheduleToolResult, CronError>> {
    const jobId = this.requireJobId(action.jobId, "update");
    if (!jobId.ok) {
      return jobId;
    }

    const existing = await this.scheduler.getJob(jobId.value);
    if (!existing.ok) {
      return existing;
    }
    if (!existing.value) {
      return err(new CronError(`Cron job not found: ${jobId.value}`, "CRON_JOB_NOT_FOUND"));
    }

    let resolvedSchedule: string | undefined;
    let scheduleNote: string | undefined;
    if (action.schedule) {
      const resolved = this.resolveSchedule(action.schedule);
      if (!resolved.ok) {
        return resolved;
      }
      resolvedSchedule = resolved.value.cron;
      scheduleNote = resolved.value.note;
    }

    const hasPayloadUpdate = action.taskAction !== undefined || action.taskParameters !== undefined;
    let policyCheck: CronPolicyResult | undefined;
    let payloadUpdate: CronJobPayload | undefined;

    if (hasPayloadUpdate) {
      payloadUpdate = {
        action: action.taskAction ?? existing.value.payload.action,
        parameters: action.taskParameters ?? existing.value.payload.parameters,
      };

      const policyResult = await this.evaluateAndApprove(payloadUpdate);
      if (!policyResult.ok) {
        return policyResult;
      }
      policyCheck = policyResult.value;
    }

    const updated = await this.scheduler.update(jobId.value, {
      name: action.name,
      description: action.description,
      schedule: resolvedSchedule,
      timezone: action.timezone,
      payload: payloadUpdate,
      maxRuns: action.maxRuns,
      tags: action.tags,
    });
    if (!updated.ok) {
      return updated;
    }

    let message = "Schedule updated";
    if (scheduleNote) {
      message += `. ${scheduleNote}`;
    }

    return ok({
      success: true,
      message,
      job: updated.value,
      policyCheck,
    });
  }

  private async delete(action: ScheduleToolAction): Promise<Result<ScheduleToolResult, CronError>> {
    const jobId = this.requireJobId(action.jobId, "delete");
    if (!jobId.ok) {
      return jobId;
    }

    const removed = await this.scheduler.remove(jobId.value);
    if (!removed.ok) {
      return removed;
    }

    return ok({
      success: true,
      message: "Schedule deleted",
    });
  }

  private async list(): Promise<Result<ScheduleToolResult, CronError>> {
    const listed = await this.scheduler.listJobs();
    if (!listed.ok) {
      return listed;
    }

    return ok({
      success: true,
      message: "Schedules listed",
      jobs: listed.value,
    });
  }

  private async get(action: ScheduleToolAction): Promise<Result<ScheduleToolResult, CronError>> {
    const jobId = this.requireJobId(action.jobId, "get");
    if (!jobId.ok) {
      return jobId;
    }

    const fetched = await this.scheduler.getJob(jobId.value);
    if (!fetched.ok) {
      return fetched;
    }

    if (!fetched.value) {
      return ok({
        success: false,
        message: `Schedule not found: ${jobId.value}`,
      });
    }

    return ok({
      success: true,
      message: "Schedule fetched",
      job: fetched.value,
    });
  }

  private async pause(action: ScheduleToolAction): Promise<Result<ScheduleToolResult, CronError>> {
    return this.setStatus(action, "paused", "Schedule paused");
  }

  private async resume(action: ScheduleToolAction): Promise<Result<ScheduleToolResult, CronError>> {
    return this.setStatus(action, "active", "Schedule resumed");
  }

  private async setStatus(
    action: ScheduleToolAction,
    status: "active" | "paused",
    message: string,
  ): Promise<Result<ScheduleToolResult, CronError>> {
    const jobId = this.requireJobId(action.jobId, action.action);
    if (!jobId.ok) {
      return jobId;
    }

    const updated = await this.scheduler.update(jobId.value, { status });
    if (!updated.ok) {
      return updated;
    }

    return ok({
      success: true,
      message,
      job: updated.value,
    });
  }

  private requireJobId(jobId: string | undefined, action: string): Result<string, CronError> {
    if (!jobId || jobId.trim().length === 0) {
      return err(new CronError(`Schedule ${action} requires a jobId`, "CRON_TOOL_JOB_ID_REQUIRED"));
    }

    return ok(jobId);
  }

  private resolveSchedule(
    schedule: string,
  ): Result<{ cron: string; note?: string }, CronError> {
    if (isCronExpression(schedule)) {
      return ok({ cron: schedule });
    }

    const parsed = parseNlTime(schedule);
    if (!parsed || !parsed.cron) {
      return err(
        new CronError(
          `Could not parse schedule: '${schedule}'. Please use a cron expression or a recognized time phrase.`,
          "CRON_TOOL_SCHEDULE_PARSE_FAILED",
        ),
      );
    }

    const note =
      parsed.confidence === "low"
        ? `Note: schedule interpreted as '${parsed.humanReadable}' (low confidence)`
        : undefined;

    return ok({ cron: parsed.cron, note });
  }

  private async evaluateAndApprove(payload: CronJobPayload): Promise<Result<CronPolicyResult, CronError>> {
    const policyCheck = evaluateCronPolicy(payload);
    if (!policyCheck.allowed) {
      return err(new CronError(policyCheck.reason, "CRON_POLICY_DENIED"));
    }

    if (!policyCheck.requiresApproval) {
      return ok(policyCheck);
    }

    if (!this.onApprovalRequired) {
      return err(
        new CronError(
          "Cron action requires approval but no approval handler is configured",
          "CRON_APPROVAL_REQUIRED",
        ),
      );
    }

    const approved = await this.onApprovalRequired({
      action: payload.action,
      reason: policyCheck.reason,
    });

    if (!approved) {
      return err(new CronError("Cron action requires approval and was denied", "CRON_APPROVAL_DENIED"));
    }

    return ok(policyCheck);
  }
}

const CRON_EXPRESSION_PATTERN = /^[\d*,/\-]+\s+[\d*,/\-]+\s+[\d*,/\-]+\s+[\d*,/\-]+\s+[\d*,/\-]+$/;

function isCronExpression(value: string): boolean {
  return CRON_EXPRESSION_PATTERN.test(value.trim());
}
