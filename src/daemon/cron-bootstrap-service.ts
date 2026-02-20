import { err, ok } from "../result";
import { HEARTBEAT_JOB_ACTION, HEARTBEAT_JOB_ID } from "../cron/jobs/heartbeat-job";
import type { CronJobCreateInput, CronJobDefinition, CronResult } from "../cron/types";
import { DaemonError, type DaemonManagedService, type DaemonResult } from "./types";

export const DEFAULT_MORNING_BRIEFING_SCHEDULE = "0 8 * * *";
export const DEFAULT_HEARTBEAT_SCHEDULE = "*/30 * * * *";
export const MORNING_BRIEFING_JOB_ID = "reins-morning-briefing";
export const MORNING_BRIEFING_JOB_ACTION = "morning-briefing.run";

interface CronBootstrapLogger {
  info(message: string, details?: Record<string, unknown>): void;
  error(message: string, details?: Record<string, unknown>): void;
}

interface CronSchedulerContract {
  start(): Promise<CronResult<void>>;
  stop(): Promise<CronResult<void>>;
  getJob(id: string): Promise<CronResult<CronJobDefinition | null>>;
  create(input: CronJobCreateInput): Promise<CronResult<CronJobDefinition>>;
}

export interface CronBootstrapServiceOptions {
  scheduler: CronSchedulerContract;
  morningBriefingSchedule?: string;
  heartbeatSchedule?: string;
  timezone?: string;
  logger?: CronBootstrapLogger;
}

const defaultLogger: CronBootstrapLogger = {
  info: (message, details) => {
    console.info(message, details ?? {});
  },
  error: (message, details) => {
    console.error(message, details ?? {});
  },
};

/**
 * Initializes daemon cron scheduling and ensures required jobs exist.
 *
 * Bootstrap failures are explicitly non-fatal to avoid blocking daemon startup.
 */
export class CronBootstrapService implements DaemonManagedService {
  readonly id = "cron-bootstrap";

  private readonly scheduler: CronSchedulerContract;
  private readonly logger: CronBootstrapLogger;
  private readonly morningBriefingSchedule: string;
  private readonly heartbeatSchedule: string;
  private readonly timezone: string;

  constructor(options: CronBootstrapServiceOptions) {
    this.scheduler = options.scheduler;
    this.logger = options.logger ?? defaultLogger;
    this.morningBriefingSchedule = options.morningBriefingSchedule ?? DEFAULT_MORNING_BRIEFING_SCHEDULE;
    this.heartbeatSchedule = options.heartbeatSchedule ?? DEFAULT_HEARTBEAT_SCHEDULE;
    this.timezone = options.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  }

  async start(): Promise<DaemonResult<void>> {
    try {
      await this.requireSuccess(this.scheduler.start(), "DAEMON_CRON_START_FAILED");
      this.logger.info("Cron scheduler initialized", {
        serviceId: this.id,
      });

      await this.registerJobIfMissing(this.buildMorningBriefingJob());
      await this.registerJobIfMissing(this.buildHeartbeatJob());

      this.logger.info("Cron bootstrap jobs registered", {
        morningBriefingSchedule: this.morningBriefingSchedule,
        heartbeatSchedule: this.heartbeatSchedule,
      });
    } catch (error) {
      this.logger.error("Cron bootstrap failed; continuing daemon startup", {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return ok(undefined);
  }

  async stop(_signal?: NodeJS.Signals): Promise<DaemonResult<void>> {
    const stopResult = await this.scheduler.stop();
    if (!stopResult.ok) {
      return err(new DaemonError(stopResult.error.message, "DAEMON_CRON_STOP_FAILED", stopResult.error));
    }

    this.logger.info("Cron scheduler stopped", {
      serviceId: this.id,
    });
    return ok(undefined);
  }

  private async registerJobIfMissing(input: CronJobCreateInput): Promise<void> {
    if (!input.id) {
      throw new DaemonError("Cron bootstrap job id is required", "DAEMON_CRON_JOB_ID_REQUIRED");
    }

    const existing = await this.requireSuccess(this.scheduler.getJob(input.id), "DAEMON_CRON_JOB_LOOKUP_FAILED");
    if (existing) {
      return;
    }

    await this.requireSuccess(this.scheduler.create(input), "DAEMON_CRON_JOB_REGISTRATION_FAILED");
  }

  private buildMorningBriefingJob(): CronJobCreateInput {
    return {
      id: MORNING_BRIEFING_JOB_ID,
      name: "morning-briefing",
      description: "Generate and deliver the daily morning briefing",
      schedule: this.morningBriefingSchedule,
      timezone: this.timezone,
      payload: {
        action: MORNING_BRIEFING_JOB_ACTION,
        parameters: {},
      },
      tags: ["system", "briefing", "proactive"],
    };
  }

  private buildHeartbeatJob(): CronJobCreateInput {
    return {
      id: HEARTBEAT_JOB_ID,
      name: "heartbeat",
      description: "Run periodic heartbeat routines",
      schedule: this.heartbeatSchedule,
      timezone: this.timezone,
      payload: {
        action: HEARTBEAT_JOB_ACTION,
        parameters: {},
      },
      tags: ["system", "heartbeat", "proactive"],
    };
  }

  private async requireSuccess<T>(resultPromise: Promise<CronResult<T>>, errorCode: string): Promise<T> {
    const result = await resultPromise;
    if (!result.ok) {
      throw new DaemonError(result.error.message, errorCode, result.error);
    }

    return result.value;
  }
}
