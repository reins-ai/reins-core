import { err, ok } from "../result";
import type {
  CronJobCreateInput,
  CronJobDefinition,
  CronJobUpdateInput,
  CronResult,
} from "./types";
import { CronError } from "./types";
import type { CronStore } from "./store";

const DEFAULT_TICK_INTERVAL_MS = 1_000;
const MAX_NEXT_RUN_SEARCH_MINUTES = 366 * 24 * 60;

interface CronSchedulerOptions {
  store: CronStore;
  tickIntervalMs?: number;
  onExecute: (job: CronJobDefinition) => Promise<void>;
  now?: () => Date;
}

export class CronScheduler {
  private readonly store: CronStore;
  private readonly tickIntervalMs: number;
  private readonly onExecute: (job: CronJobDefinition) => Promise<void>;
  private readonly now: () => Date;
  private readonly jobs = new Map<string, CronJobDefinition>();
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private tickPromise: Promise<void> | null = null;
  private running = false;

  constructor(options: CronSchedulerOptions) {
    this.store = options.store;
    this.tickIntervalMs = options.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.onExecute = options.onExecute;
    this.now = options.now ?? (() => new Date());
  }

  async start(): Promise<CronResult<void>> {
    if (this.running) {
      return ok(undefined);
    }

    const listed = await this.store.list();
    if (!listed.ok) {
      return listed;
    }

    this.jobs.clear();
    for (const job of listed.value) {
      this.jobs.set(job.id, job);
    }

    this.running = true;
    this.intervalId = setInterval(() => {
      void this.tick();
    }, this.tickIntervalMs);

    return ok(undefined);
  }

  async stop(): Promise<CronResult<void>> {
    this.running = false;

    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }

    if (this.tickPromise) {
      await this.tickPromise;
    }

    return ok(undefined);
  }

  async create(input: CronJobCreateInput): Promise<CronResult<CronJobDefinition>> {
    const validated = this.validateCreateInput(input);
    if (!validated.ok) {
      return validated;
    }

    const now = this.now();
    const timezone = input.timezone ?? getSystemTimezone();
    const nextRunAt = computeNextRunAt(input.schedule, timezone, now);
    if (!nextRunAt.ok) {
      return nextRunAt;
    }

    const job: CronJobDefinition = {
      id: crypto.randomUUID(),
      name: input.name.trim(),
      description: input.description?.trim() ?? "",
      schedule: input.schedule.trim(),
      timezone,
      status: "active",
      createdBy: "agent",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      lastRunAt: null,
      nextRunAt: nextRunAt.value,
      runCount: 0,
      maxRuns: input.maxRuns ?? null,
      payload: {
        action: input.payload.action,
        parameters: input.payload.parameters,
      },
      tags: normalizeTags(input.tags),
    };

    const saved = await this.store.save(job);
    if (!saved.ok) {
      return saved;
    }

    this.jobs.set(job.id, job);
    return ok(cloneJob(job));
  }

  async update(id: string, input: CronJobUpdateInput): Promise<CronResult<CronJobDefinition>> {
    const existing = await this.getRequiredJob(id);
    if (!existing.ok) {
      return existing;
    }

    const current = existing.value;
    const now = this.now();

    const updated: CronJobDefinition = {
      ...current,
      name: input.name !== undefined ? input.name.trim() : current.name,
      description: input.description !== undefined ? input.description.trim() : current.description,
      schedule: input.schedule !== undefined ? input.schedule.trim() : current.schedule,
      timezone: input.timezone ?? current.timezone,
      status: input.status ?? current.status,
      payload: input.payload
        ? {
            action: input.payload.action,
            parameters: input.payload.parameters,
          }
        : current.payload,
      maxRuns: input.maxRuns !== undefined ? input.maxRuns : current.maxRuns,
      tags: input.tags !== undefined ? normalizeTags(input.tags) : current.tags,
      updatedAt: now.toISOString(),
    };

    const validated = this.validateJob(updated);
    if (!validated.ok) {
      return validated;
    }

    if (updated.status === "active") {
      const nextRunAt = computeNextRunAt(updated.schedule, updated.timezone, now);
      if (!nextRunAt.ok) {
        return nextRunAt;
      }
      updated.nextRunAt = nextRunAt.value;
    }

    if (updated.status === "paused" || updated.status === "failed" || updated.status === "completed") {
      updated.nextRunAt = null;
    }

    const saved = await this.store.save(updated);
    if (!saved.ok) {
      return saved;
    }

    this.jobs.set(updated.id, updated);
    return ok(cloneJob(updated));
  }

  async remove(id: string): Promise<CronResult<void>> {
    const deleted = await this.store.delete(id);
    if (!deleted.ok) {
      return deleted;
    }

    this.jobs.delete(id);
    return ok(undefined);
  }

  async getJob(id: string): Promise<CronResult<CronJobDefinition | null>> {
    const fromMemory = this.jobs.get(id);
    if (fromMemory) {
      return ok(cloneJob(fromMemory));
    }

    const fromStore = await this.store.get(id);
    if (!fromStore.ok) {
      return fromStore;
    }

    return ok(fromStore.value ? cloneJob(fromStore.value) : null);
  }

  async listJobs(): Promise<CronResult<CronJobDefinition[]>> {
    const listed = await this.store.list();
    if (!listed.ok) {
      return listed;
    }

    const jobs = listed.value.map(cloneJob);
    this.jobs.clear();
    for (const job of listed.value) {
      this.jobs.set(job.id, job);
    }

    return ok(jobs);
  }

  isRunning(): boolean {
    return this.running;
  }

  private async tick(): Promise<void> {
    if (this.tickPromise) {
      return;
    }

    this.tickPromise = this.runTick();
    try {
      await this.tickPromise;
    } finally {
      this.tickPromise = null;
    }
  }

  private async runTick(): Promise<void> {
    if (!this.running) {
      return;
    }

    const now = this.now();
    for (const [id, job] of this.jobs.entries()) {
      if (!isExecutionDue(job, now)) {
        continue;
      }

      const executed = await this.executeJob(job, now);
      if (!executed.ok) {
        continue;
      }

      this.jobs.set(id, executed.value);
    }
  }

  private async executeJob(job: CronJobDefinition, executedAt: Date): Promise<CronResult<CronJobDefinition>> {
    const next: CronJobDefinition = {
      ...job,
      lastRunAt: executedAt.toISOString(),
      runCount: job.runCount + 1,
      updatedAt: executedAt.toISOString(),
    };

    try {
      await this.onExecute(cloneJob(job));

      if (next.maxRuns !== null && next.runCount >= next.maxRuns) {
        next.status = "completed";
        next.nextRunAt = null;
      } else {
        const nextRunAt = computeNextRunAt(next.schedule, next.timezone, executedAt);
        if (!nextRunAt.ok) {
          next.status = "failed";
          next.nextRunAt = null;
        } else {
          next.status = "active";
          next.nextRunAt = nextRunAt.value;
        }
      }
    } catch {
      next.status = "failed";
      next.nextRunAt = null;
    }

    const saved = await this.store.save(next);
    if (!saved.ok) {
      return saved;
    }

    return ok(next);
  }

  private async getRequiredJob(id: string): Promise<CronResult<CronJobDefinition>> {
    const fromMemory = this.jobs.get(id);
    if (fromMemory) {
      return ok(fromMemory);
    }

    const fromStore = await this.store.get(id);
    if (!fromStore.ok) {
      return fromStore;
    }

    if (!fromStore.value) {
      return err(new CronError(`Cron job not found: ${id}`, "CRON_JOB_NOT_FOUND"));
    }

    this.jobs.set(id, fromStore.value);
    return ok(fromStore.value);
  }

  private validateCreateInput(input: CronJobCreateInput): CronResult<void> {
    const candidate: CronJobDefinition = {
      id: "candidate",
      name: input.name,
      description: input.description ?? "",
      schedule: input.schedule,
      timezone: input.timezone ?? getSystemTimezone(),
      status: "active",
      createdBy: "agent",
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      maxRuns: input.maxRuns ?? null,
      payload: input.payload,
      tags: normalizeTags(input.tags),
    };

    return this.validateJob(candidate);
  }

  private validateJob(job: CronJobDefinition): CronResult<void> {
    if (job.name.trim().length === 0) {
      return err(new CronError("Cron job name is required", "CRON_JOB_NAME_REQUIRED"));
    }

    if (job.payload.action.trim().length === 0) {
      return err(new CronError("Cron job payload action is required", "CRON_JOB_ACTION_REQUIRED"));
    }

    if (job.maxRuns !== null && job.maxRuns <= 0) {
      return err(new CronError("Cron job maxRuns must be greater than zero", "CRON_JOB_MAX_RUNS_INVALID"));
    }

    const timezoneResult = validateTimezone(job.timezone);
    if (!timezoneResult.ok) {
      return timezoneResult;
    }

    const scheduleResult = validateCronExpression(job.schedule);
    if (!scheduleResult.ok) {
      return scheduleResult;
    }

    return ok(undefined);
  }
}

function cloneJob(job: CronJobDefinition): CronJobDefinition {
  return structuredClone(job);
}

function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) {
    return [];
  }

  return Array.from(new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0)));
}

function isExecutionDue(job: CronJobDefinition, now: Date): boolean {
  if (job.status !== "active") {
    return false;
  }

  if (job.nextRunAt === null) {
    return false;
  }

  const nextRun = Date.parse(job.nextRunAt);
  if (Number.isNaN(nextRun)) {
    return false;
  }

  return nextRun <= now.getTime();
}

function getSystemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
}

function validateTimezone(timezone: string): CronResult<void> {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return ok(undefined);
  } catch (cause) {
    return err(new CronError(`Invalid timezone: ${timezone}`, "CRON_TIMEZONE_INVALID", asError(cause)));
  }
}

function validateCronExpression(expression: string): CronResult<void> {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return err(new CronError("Cron expression must contain five fields", "CRON_EXPRESSION_INVALID"));
  }

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;

  const validators: Array<{ value: string; min: number; max: number; label: string }> = [
    { value: minute, min: 0, max: 59, label: "minute" },
    { value: hour, min: 0, max: 23, label: "hour" },
    { value: dayOfMonth, min: 1, max: 31, label: "day-of-month" },
    { value: month, min: 1, max: 12, label: "month" },
    { value: dayOfWeek, min: 0, max: 7, label: "day-of-week" },
  ];

  for (const validator of validators) {
    const parsed = parseCronField(validator.value, validator.min, validator.max);
    if (!parsed.ok) {
      return err(
        new CronError(
          `Invalid ${validator.label} field in cron expression`,
          "CRON_EXPRESSION_INVALID",
          parsed.error,
        ),
      );
    }
  }

  return ok(undefined);
}

export function isJobDue(job: CronJobDefinition, now: Date): boolean {
  if (job.status !== "active") {
    return false;
  }

  const parsed = parseCronExpression(job.schedule);
  if (!parsed.ok) {
    return false;
  }

  const partsResult = getTimeParts(now, job.timezone);
  if (!partsResult.ok) {
    return false;
  }

  const parts = partsResult.value;
  return (
    matchesField(parsed.value.minute, parts.minute, 0) &&
    matchesField(parsed.value.hour, parts.hour, 0) &&
    matchesField(parsed.value.dayOfMonth, parts.dayOfMonth, 0) &&
    matchesField(parsed.value.month, parts.month, 0) &&
    matchesField(parsed.value.dayOfWeek, parts.dayOfWeek, 7)
  );
}

interface ParsedCronExpression {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

interface ParsedFieldPart {
  start: number;
  end: number;
  step: number;
  wildcard: boolean;
}

interface TimeParts {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

function parseCronExpression(expression: string): CronResult<ParsedCronExpression> {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return err(new CronError("Cron expression must contain five fields", "CRON_EXPRESSION_INVALID"));
  }

  return ok({
    minute: fields[0]!,
    hour: fields[1]!,
    dayOfMonth: fields[2]!,
    month: fields[3]!,
    dayOfWeek: fields[4]!,
  });
}

function matchesField(field: string, value: number, aliasValue: number): boolean {
  const segments = field.split(",");

  for (const segment of segments) {
    const parsed = parseCronFieldPart(segment.trim());
    if (!parsed.ok) {
      return false;
    }

    const part = parsed.value;
    if (part.wildcard) {
      if (valueInStepRange(value, part.start, part.end, part.step)) {
        return true;
      }
      if (aliasValue !== 0 && valueInStepRange(aliasValue, part.start, part.end, part.step)) {
        return true;
      }
      continue;
    }

    if (valueInStepRange(value, part.start, part.end, part.step)) {
      return true;
    }

    if (aliasValue !== 0 && valueInStepRange(aliasValue, part.start, part.end, part.step)) {
      return true;
    }
  }

  return false;
}

function valueInStepRange(value: number, start: number, end: number, step: number): boolean {
  if (value < start || value > end) {
    return false;
  }

  return (value - start) % step === 0;
}

function parseCronField(field: string, min: number, max: number): CronResult<void> {
  const parts = field.split(",").map((part) => part.trim());
  if (parts.length === 0) {
    return err(new CronError("Cron field is empty", "CRON_EXPRESSION_INVALID"));
  }

  for (const part of parts) {
    const parsed = parseCronFieldPart(part);
    if (!parsed.ok) {
      return parsed;
    }

    if (parsed.value.wildcard) {
      continue;
    }

    if (parsed.value.start < min || parsed.value.end > max) {
      return err(new CronError("Cron field value is out of range", "CRON_EXPRESSION_INVALID"));
    }

    if (parsed.value.start > parsed.value.end) {
      return err(new CronError("Cron range start must be <= end", "CRON_EXPRESSION_INVALID"));
    }
  }

  return ok(undefined);
}

function parseCronFieldPart(part: string): CronResult<ParsedFieldPart> {
  if (part.length === 0) {
    return err(new CronError("Cron field segment is empty", "CRON_EXPRESSION_INVALID"));
  }

  let rangePart = part;
  let step = 1;

  if (part.includes("/")) {
    const [left, right] = part.split("/");
    if (!left || !right) {
      return err(new CronError("Invalid step expression", "CRON_EXPRESSION_INVALID"));
    }

    const parsedStep = Number(right);
    if (!Number.isInteger(parsedStep) || parsedStep <= 0) {
      return err(new CronError("Cron step must be a positive integer", "CRON_EXPRESSION_INVALID"));
    }

    rangePart = left;
    step = parsedStep;
  }

  if (rangePart === "*") {
    return ok({
      start: 0,
      end: Number.MAX_SAFE_INTEGER,
      step,
      wildcard: true,
    });
  }

  if (rangePart.includes("-")) {
    const [startText, endText] = rangePart.split("-");
    if (!startText || !endText) {
      return err(new CronError("Invalid range expression", "CRON_EXPRESSION_INVALID"));
    }

    const start = Number(startText);
    const end = Number(endText);
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      return err(new CronError("Cron range must use integer values", "CRON_EXPRESSION_INVALID"));
    }

    return ok({
      start,
      end,
      step,
      wildcard: false,
    });
  }

  const value = Number(rangePart);
  if (!Number.isInteger(value)) {
    return err(new CronError("Cron value must be an integer", "CRON_EXPRESSION_INVALID"));
  }

  return ok({
    start: value,
    end: value,
    step,
    wildcard: false,
  });
}

function computeNextRunAt(schedule: string, timezone: string, from: Date): CronResult<string | null> {
  const expression = parseCronExpression(schedule);
  if (!expression.ok) {
    return expression;
  }

  const timezoneValidation = validateTimezone(timezone);
  if (!timezoneValidation.ok) {
    return timezoneValidation;
  }

  const candidate = new Date(from.getTime());
  candidate.setUTCSeconds(0, 0);
  candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);

  for (let index = 0; index < MAX_NEXT_RUN_SEARCH_MINUTES; index += 1) {
    const job: CronJobDefinition = {
      id: "probe",
      name: "probe",
      description: "",
      schedule,
      timezone,
      status: "active",
      createdBy: "probe",
      createdAt: from.toISOString(),
      updatedAt: from.toISOString(),
      lastRunAt: null,
      nextRunAt: null,
      runCount: 0,
      maxRuns: null,
      payload: { action: "probe", parameters: {} },
      tags: [],
    };

    if (isJobDue(job, candidate)) {
      return ok(candidate.toISOString());
    }

    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  return err(new CronError("Unable to compute next cron execution time", "CRON_NEXT_RUN_COMPUTE_FAILED"));
}

function getTimeParts(date: Date, timezone: string): CronResult<TimeParts> {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      minute: "numeric",
      hour: "numeric",
      day: "numeric",
      month: "numeric",
      weekday: "short",
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const minute = numberPart(parts, "minute");
    const hour = numberPart(parts, "hour");
    const dayOfMonth = numberPart(parts, "day");
    const month = numberPart(parts, "month");
    const weekdayName = stringPart(parts, "weekday");

    const dayOfWeek = weekdayToNumber(weekdayName);
    if (dayOfWeek === null) {
      return err(new CronError(`Invalid weekday value: ${weekdayName}`, "CRON_WEEKDAY_INVALID"));
    }

    return ok({
      minute,
      hour,
      dayOfMonth,
      month,
      dayOfWeek,
    });
  } catch (cause) {
    return err(new CronError("Failed to get date parts for cron evaluation", "CRON_TIME_PARTS_FAILED", asError(cause)));
  }
}

function numberPart(parts: Intl.DateTimeFormatPart[], key: Intl.DateTimeFormatPartTypes): number {
  const found = parts.find((part) => part.type === key)?.value;
  if (!found) {
    throw new CronError(`Missing time part: ${key}`, "CRON_TIME_PART_MISSING");
  }

  const parsed = Number(found);
  if (!Number.isFinite(parsed)) {
    throw new CronError(`Invalid numeric time part: ${key}`, "CRON_TIME_PART_INVALID");
  }

  return parsed;
}

function stringPart(parts: Intl.DateTimeFormatPart[], key: Intl.DateTimeFormatPartTypes): string {
  const found = parts.find((part) => part.type === key)?.value;
  if (!found) {
    throw new CronError(`Missing string time part: ${key}`, "CRON_TIME_PART_MISSING");
  }

  return found;
}

function weekdayToNumber(value: string): number | null {
  const normalized = value.toLowerCase();
  if (normalized.startsWith("sun")) {
    return 0;
  }
  if (normalized.startsWith("mon")) {
    return 1;
  }
  if (normalized.startsWith("tue")) {
    return 2;
  }
  if (normalized.startsWith("wed")) {
    return 3;
  }
  if (normalized.startsWith("thu")) {
    return 4;
  }
  if (normalized.startsWith("fri")) {
    return 5;
  }
  if (normalized.startsWith("sat")) {
    return 6;
  }

  return null;
}

function asError(cause: unknown): Error | undefined {
  return cause instanceof Error ? cause : undefined;
}
