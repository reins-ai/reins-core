import type { CronRateLimiter } from "./rate-limit";
import type { CronJobDefinition } from "./types";

export type CronAuditEventType =
  | "cron.created"
  | "cron.updated"
  | "cron.deleted"
  | "cron.executed"
  | "cron.failed"
  | "cron.paused"
  | "cron.resumed"
  | "cron.rate_limited";

export interface CronAuditEntry {
  timestamp: number;
  eventType: CronAuditEventType;
  jobId: string;
  jobName: string;
  action: string;
  success: boolean;
  durationMs?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface CronAuditLog {
  record(entry: CronAuditEntry): void;
  getEntries(jobId?: string): CronAuditEntry[];
  getEntriesByType(eventType: CronAuditEventType): CronAuditEntry[];
  clear(): void;
}

export class InMemoryCronAuditLog implements CronAuditLog {
  private readonly entries: CronAuditEntry[] = [];

  record(entry: CronAuditEntry): void {
    this.entries.push(structuredClone(entry));
  }

  getEntries(jobId?: string): CronAuditEntry[] {
    if (!jobId) {
      return this.entries.map((entry) => structuredClone(entry));
    }

    return this.entries
      .filter((entry) => entry.jobId === jobId)
      .map((entry) => structuredClone(entry));
  }

  getEntriesByType(eventType: CronAuditEventType): CronAuditEntry[] {
    return this.entries
      .filter((entry) => entry.eventType === eventType)
      .map((entry) => structuredClone(entry));
  }

  clear(): void {
    this.entries.length = 0;
  }
}

export interface CronExecutorOptions {
  rateLimiter: CronRateLimiter;
  auditLog: CronAuditLog;
  handler: (job: CronJobDefinition) => Promise<void>;
  now?: () => Date;
}

export class CronExecutor {
  constructor(private readonly options: CronExecutorOptions) {}

  async execute(job: CronJobDefinition): Promise<void> {
    const startedAt = this.now().getTime();
    const rateLimitResult = this.options.rateLimiter.tryAcquire(startedAt);
    if (!rateLimitResult.ok) {
      this.options.auditLog.record({
        timestamp: startedAt,
        eventType: "cron.rate_limited",
        jobId: job.id,
        jobName: job.name,
        action: job.payload.action,
        success: false,
        error: rateLimitResult.error.message,
      });
      throw rateLimitResult.error;
    }

    try {
      await this.options.handler(job);
      const endedAt = this.now().getTime();
      this.options.auditLog.record({
        timestamp: endedAt,
        eventType: "cron.executed",
        jobId: job.id,
        jobName: job.name,
        action: job.payload.action,
        success: true,
        durationMs: Math.max(0, endedAt - startedAt),
      });
    } catch (error) {
      const endedAt = this.now().getTime();
      this.options.auditLog.record({
        timestamp: endedAt,
        eventType: "cron.failed",
        jobId: job.id,
        jobName: job.name,
        action: job.payload.action,
        success: false,
        durationMs: Math.max(0, endedAt - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  logCreated(job: CronJobDefinition): void {
    this.logLifecycleEvent("cron.created", job.id, job.name, job.payload.action);
  }

  logUpdated(job: CronJobDefinition): void {
    this.logLifecycleEvent("cron.updated", job.id, job.name, job.payload.action);
  }

  logDeleted(jobId: string, jobName: string, action = "delete"): void {
    this.logLifecycleEvent("cron.deleted", jobId, jobName, action);
  }

  logPaused(job: CronJobDefinition): void {
    this.logLifecycleEvent("cron.paused", job.id, job.name, job.payload.action);
  }

  logResumed(job: CronJobDefinition): void {
    this.logLifecycleEvent("cron.resumed", job.id, job.name, job.payload.action);
  }

  getAuditLog(): CronAuditLog {
    return this.options.auditLog;
  }

  getRateLimiter(): CronRateLimiter {
    return this.options.rateLimiter;
  }

  private logLifecycleEvent(eventType: CronAuditEventType, jobId: string, jobName: string, action: string): void {
    this.options.auditLog.record({
      timestamp: this.now().getTime(),
      eventType,
      jobId,
      jobName,
      action,
      success: true,
    });
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }
}
