import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type {
  ConsolidationRunner,
  ConsolidationRunResult,
} from "../../memory/consolidation/consolidation-runner";

export interface ConsolidationScheduleConfig {
  intervalMs: number;
  enabled: boolean;
}

export const DEFAULT_CONSOLIDATION_SCHEDULE: ConsolidationScheduleConfig = {
  intervalMs: 6 * 60 * 60 * 1000,
  enabled: true,
};

export class ConsolidationJobError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "ConsolidationJobError";
  }
}

export interface ConsolidationJobOptions {
  runner: ConsolidationRunner;
  schedule?: Partial<ConsolidationScheduleConfig>;
  onComplete?: (result: ConsolidationRunResult) => void;
  onError?: (error: ConsolidationJobError) => void;
  now?: () => Date;
}

export class MemoryConsolidationJob {
  private readonly runner: ConsolidationRunner;
  private readonly schedule: ConsolidationScheduleConfig;
  private readonly onComplete: ((result: ConsolidationRunResult) => void) | undefined;
  private readonly onError: ((error: ConsolidationJobError) => void) | undefined;
  private readonly now: () => Date;
  private intervalId: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private executing = false;
  private lastRunAt: Date | undefined;
  private lastResult: ConsolidationRunResult | undefined;
  private runCount = 0;

  constructor(options: ConsolidationJobOptions) {
    this.runner = options.runner;
    this.schedule = {
      intervalMs: options.schedule?.intervalMs ?? DEFAULT_CONSOLIDATION_SCHEDULE.intervalMs,
      enabled: options.schedule?.enabled ?? DEFAULT_CONSOLIDATION_SCHEDULE.enabled,
    };
    this.onComplete = options.onComplete;
    this.onError = options.onError;
    this.now = options.now ?? (() => new Date());
  }

  start(): Result<void, ConsolidationJobError> {
    if (this.running) {
      return ok(undefined);
    }

    if (!this.schedule.enabled) {
      return err(
        new ConsolidationJobError(
          "Cannot start disabled consolidation job",
          "CONSOLIDATION_JOB_DISABLED",
        ),
      );
    }

    if (this.schedule.intervalMs <= 0) {
      return err(
        new ConsolidationJobError(
          "Consolidation interval must be greater than zero",
          "CONSOLIDATION_JOB_INVALID_INTERVAL",
        ),
      );
    }

    this.running = true;
    this.intervalId = setInterval(() => {
      void this.executeInternal();
    }, this.schedule.intervalMs);

    return ok(undefined);
  }

  stop(): void {
    this.running = false;

    if (this.intervalId !== undefined) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
  }

  async triggerNow(): Promise<Result<ConsolidationRunResult, ConsolidationJobError>> {
    if (this.executing) {
      return err(
        new ConsolidationJobError(
          "Consolidation is already running",
          "CONSOLIDATION_JOB_ALREADY_RUNNING",
        ),
      );
    }

    return this.executeInternal();
  }

  isRunning(): boolean {
    return this.running;
  }

  isExecuting(): boolean {
    return this.executing;
  }

  getLastRunAt(): Date | undefined {
    return this.lastRunAt;
  }

  getLastResult(): ConsolidationRunResult | undefined {
    return this.lastResult;
  }

  getRunCount(): number {
    return this.runCount;
  }

  getSchedule(): ConsolidationScheduleConfig {
    return { ...this.schedule };
  }

  private async executeInternal(): Promise<Result<ConsolidationRunResult, ConsolidationJobError>> {
    if (this.executing) {
      return err(
        new ConsolidationJobError(
          "Consolidation is already running",
          "CONSOLIDATION_JOB_ALREADY_RUNNING",
        ),
      );
    }

    this.executing = true;

    try {
      const result = await this.runner.run();

      if (!result.ok) {
        const jobError = new ConsolidationJobError(
          `Consolidation run failed: ${result.error.message}`,
          "CONSOLIDATION_JOB_RUN_FAILED",
          result.error,
        );
        this.onError?.(jobError);
        return err(jobError);
      }

      this.lastRunAt = this.now();
      this.lastResult = result.value;
      this.runCount += 1;
      this.onComplete?.(result.value);

      return ok(result.value);
    } catch (error: unknown) {
      const cause = error instanceof Error ? error : undefined;
      const jobError = new ConsolidationJobError(
        "Unexpected error during consolidation run",
        "CONSOLIDATION_JOB_UNEXPECTED_ERROR",
        cause,
      );
      this.onError?.(jobError);
      return err(jobError);
    } finally {
      this.executing = false;
    }
  }
}
