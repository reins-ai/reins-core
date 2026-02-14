import { ReinsError } from "../errors";

export type CronJobStatus = "active" | "paused" | "completed" | "failed";

export interface CronJobDefinition {
  id: string;
  name: string;
  description: string;
  schedule: string;
  timezone: string;
  status: CronJobStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  runCount: number;
  maxRuns: number | null;
  payload: CronJobPayload;
  tags: string[];
}

export type CronJob = CronJobDefinition;

export interface CronJobPayload {
  action: string;
  parameters: Record<string, unknown>;
}

export interface CronJobCreateInput {
  id?: string;
  name: string;
  description?: string;
  schedule: string;
  timezone?: string;
  payload: CronJobPayload;
  maxRuns?: number | null;
  tags?: string[];
}

export interface CronJobUpdateInput {
  name?: string;
  description?: string;
  schedule?: string;
  timezone?: string;
  status?: CronJobStatus;
  payload?: CronJobPayload;
  maxRuns?: number | null;
  tags?: string[];
}

export interface CronExecutionRecord {
  jobId: string;
  executedAt: string;
  durationMs: number;
  success: boolean;
  error: string | null;
}

export class CronError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "CronError";
  }
}

export type CronResult<T> = import("../result").Result<T, CronError>;
