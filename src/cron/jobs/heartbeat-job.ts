import {
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  MAX_HEARTBEAT_INTERVAL_MINUTES,
  MIN_HEARTBEAT_INTERVAL_MINUTES,
} from "../../config/format-decision";
import type { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { EnvironmentError } from "../../environment/errors";
import type { OverlayResolution } from "../../environment/types";
import type { CronJob, CronJobDefinition } from "../types";
import { CronError } from "../types";

export const HEARTBEAT_JOB_ID = "reins-heartbeat";
export const HEARTBEAT_JOB_ACTION = "heartbeat.run";

const HEARTBEAT_MAX_CRON_INTERVAL_MINUTES = 59;

export interface HeartbeatJobOptions {
  intervalMinutes?: number;
  environmentName?: string;
}

export interface HeartbeatContext {
  currentEnvironment: string;
  resolvedDocuments: OverlayResolution;
  timestamp: Date;
}

export interface HeartbeatResult {
  action: "executed" | "skipped" | "suppressed";
  output?: string;
  reason?: string;
}

export interface HeartbeatHandler {
  execute(context: HeartbeatContext): Promise<HeartbeatResult>;
}

export interface HeartbeatEnvironmentResolver {
  getCurrentEnvironment(): Promise<Result<string, ReinsError>>;
  getResolvedDocuments(environmentName?: string): Promise<Result<OverlayResolution, EnvironmentError>>;
}

export class NoopHeartbeatHandler implements HeartbeatHandler {
  async execute(_context: HeartbeatContext): Promise<HeartbeatResult> {
    return {
      action: "suppressed",
      reason: "Heartbeat handler is not implemented yet",
    };
  }
}

export function createHeartbeatJob(options: HeartbeatJobOptions = {}): CronJob {
  const intervalMinutes = normalizeHeartbeatInterval(options.intervalMinutes);
  const now = new Date().toISOString();
  const environmentName = options.environmentName?.trim();

  const job: CronJobDefinition = {
    id: HEARTBEAT_JOB_ID,
    name: "heartbeat",
    description: "Periodic HEARTBEAT.md self-check execution",
    schedule: toHeartbeatCronExpression(intervalMinutes),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    status: "active",
    createdBy: "system",
    createdAt: now,
    updatedAt: now,
    lastRunAt: null,
    nextRunAt: null,
    runCount: 0,
    maxRuns: null,
    payload: {
      action: HEARTBEAT_JOB_ACTION,
      parameters: {
        intervalMinutes,
        environmentName: environmentName && environmentName.length > 0 ? environmentName : null,
      },
    },
    tags: ["system", "heartbeat"],
  };

  return job;
}

export function toHeartbeatCronExpression(intervalMinutes: number): string {
  const interval = normalizeHeartbeatInterval(intervalMinutes);
  return `*/${interval} * * * *`;
}

export async function resolveHeartbeatContext(
  resolver: HeartbeatEnvironmentResolver,
  options: HeartbeatJobOptions = {},
  now: () => Date = () => new Date(),
): Promise<Result<HeartbeatContext, ReinsError>> {
  const currentEnvironmentResult = options.environmentName
    ? ok(options.environmentName)
    : await resolver.getCurrentEnvironment();

  if (!currentEnvironmentResult.ok) {
    return err(currentEnvironmentResult.error);
  }

  const resolvedDocumentsResult = await resolver.getResolvedDocuments(currentEnvironmentResult.value);
  if (!resolvedDocumentsResult.ok) {
    return err(resolvedDocumentsResult.error);
  }

  return ok({
    currentEnvironment: currentEnvironmentResult.value,
    resolvedDocuments: resolvedDocumentsResult.value,
    timestamp: now(),
  });
}

function normalizeHeartbeatInterval(value: number | undefined): number {
  const candidate = value ?? DEFAULT_HEARTBEAT_INTERVAL_MINUTES;

  if (!Number.isInteger(candidate)) {
    throw new CronError("Heartbeat interval must be an integer", "CRON_HEARTBEAT_INTERVAL_INVALID");
  }

  if (candidate < MIN_HEARTBEAT_INTERVAL_MINUTES || candidate > MAX_HEARTBEAT_INTERVAL_MINUTES) {
    throw new CronError(
      `Heartbeat interval must be between ${MIN_HEARTBEAT_INTERVAL_MINUTES} and ${MAX_HEARTBEAT_INTERVAL_MINUTES} minutes`,
      "CRON_HEARTBEAT_INTERVAL_OUT_OF_RANGE",
    );
  }

  if (candidate > HEARTBEAT_MAX_CRON_INTERVAL_MINUTES) {
    throw new CronError(
      "Heartbeat interval must be 59 minutes or less for 5-field cron schedules",
      "CRON_HEARTBEAT_INTERVAL_UNSUPPORTED",
    );
  }

  return candidate;
}
