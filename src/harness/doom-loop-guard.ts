const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_MAX_TOTAL_FAILURES = 5;

export interface DoomLoopGuardOptions {
  maxConsecutiveFailures?: number;
  maxTotalFailures?: number;
}

export class DoomLoopGuard {
  private readonly maxConsecutiveFailures: number;
  private readonly maxTotalFailures: number;

  private consecutiveFailures = 0;
  private totalFailures = 0;

  constructor(options: DoomLoopGuardOptions = {}) {
    this.maxConsecutiveFailures = this.resolveLimit(
      options.maxConsecutiveFailures,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
    );
    this.maxTotalFailures = this.resolveLimit(options.maxTotalFailures, DEFAULT_MAX_TOTAL_FAILURES);
  }

  public recordFailure(_toolName: string): void {
    this.consecutiveFailures += 1;
    this.totalFailures += 1;
  }

  public recordSuccess(_toolName: string): void {
    this.consecutiveFailures = 0;
  }

  public resetTurn(): void {
    this.consecutiveFailures = 0;
    this.totalFailures = 0;
  }

  public shouldEscalate(): boolean {
    return (
      this.consecutiveFailures >= this.maxConsecutiveFailures ||
      this.totalFailures >= this.maxTotalFailures
    );
  }

  public getFailureCount(): number {
    return this.totalFailures;
  }

  private resolveLimit(candidate: number | undefined, fallback: number): number {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      return fallback;
    }

    return Math.max(1, Math.floor(candidate));
  }
}
