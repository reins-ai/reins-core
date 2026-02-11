import { err, ok, type Result } from "../result";
import { CronError } from "./types";

export interface RateLimitConfig {
  maxExecutionsPerMinute: number;
  maxExecutionsPerHour: number;
}

export interface CronRateLimitUsage {
  minuteCount: number;
  hourCount: number;
  minuteLimit: number;
  hourLimit: number;
}

export class CronRateLimiter {
  private readonly minuteWindow: number[];
  private readonly hourWindow: number[];
  private readonly config: Required<RateLimitConfig>;

  constructor(config: Partial<RateLimitConfig> = {}) {
    this.config = {
      maxExecutionsPerMinute: config.maxExecutionsPerMinute ?? 10,
      maxExecutionsPerHour: config.maxExecutionsPerHour ?? 100,
    };
    this.minuteWindow = [];
    this.hourWindow = [];
  }

  tryAcquire(now?: number): Result<void, CronError> {
    const timestamp = now ?? Date.now();
    this.pruneWindows(timestamp);

    if (this.minuteWindow.length >= this.config.maxExecutionsPerMinute) {
      return err(
        new CronError(
          `Rate limit exceeded: ${this.config.maxExecutionsPerMinute} executions per minute`,
          "CRON_RATE_LIMIT_MINUTE",
        ),
      );
    }

    if (this.hourWindow.length >= this.config.maxExecutionsPerHour) {
      return err(
        new CronError(
          `Rate limit exceeded: ${this.config.maxExecutionsPerHour} executions per hour`,
          "CRON_RATE_LIMIT_HOUR",
        ),
      );
    }

    this.minuteWindow.push(timestamp);
    this.hourWindow.push(timestamp);
    return ok(undefined);
  }

  getUsage(now?: number): CronRateLimitUsage {
    const timestamp = now ?? Date.now();
    this.pruneWindows(timestamp);
    return {
      minuteCount: this.minuteWindow.length,
      hourCount: this.hourWindow.length,
      minuteLimit: this.config.maxExecutionsPerMinute,
      hourLimit: this.config.maxExecutionsPerHour,
    };
  }

  reset(): void {
    this.minuteWindow.length = 0;
    this.hourWindow.length = 0;
  }

  private pruneWindows(now: number): void {
    const minuteCutoff = now - 60_000;
    const hourCutoff = now - 3_600_000;

    for (let index = this.minuteWindow.length - 1; index >= 0; index -= 1) {
      if (this.minuteWindow[index]! <= minuteCutoff) {
        this.minuteWindow.splice(index, 1);
      }
    }

    for (let index = this.hourWindow.length - 1; index >= 0; index -= 1) {
      if (this.hourWindow[index]! <= hourCutoff) {
        this.hourWindow.splice(index, 1);
      }
    }
  }
}
