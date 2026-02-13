const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_MAX_TOTAL_FAILURES = 5;
const DEFAULT_WINDOW_SIZE = 10;
const DEFAULT_REPETITION_THRESHOLD = 3;

export interface DoomLoopGuardOptions {
  maxConsecutiveFailures?: number;
  maxTotalFailures?: number;
  windowSize?: number;
  repetitionThreshold?: number;
}

export class DoomLoopGuard {
  private readonly maxConsecutiveFailures: number;
  private readonly maxTotalFailures: number;
  private readonly windowSize: number;
  private readonly repetitionThreshold: number;

  private consecutiveFailures = 0;
  private totalFailures = 0;
  private recentCallSignatures: string[] = [];

  constructor(options: DoomLoopGuardOptions = {}) {
    this.maxConsecutiveFailures = this.resolveLimit(
      options.maxConsecutiveFailures,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
    );
    this.maxTotalFailures = this.resolveLimit(options.maxTotalFailures, DEFAULT_MAX_TOTAL_FAILURES);
    this.windowSize = this.resolveLimit(options.windowSize, DEFAULT_WINDOW_SIZE);
    this.repetitionThreshold = this.resolveLimit(
      options.repetitionThreshold,
      DEFAULT_REPETITION_THRESHOLD,
    );
  }

  public track(toolCalls: Array<{ name: string; arguments?: Record<string, unknown> }>): void {
    for (const toolCall of toolCalls) {
      this.recentCallSignatures.push(this.toSignature(toolCall.name, toolCall.arguments ?? {}));
    }

    const overflow = this.recentCallSignatures.length - this.windowSize;
    if (overflow > 0) {
      this.recentCallSignatures.splice(0, overflow);
    }
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
    this.recentCallSignatures = [];
  }

  public reset(): void {
    this.consecutiveFailures = 0;
    this.totalFailures = 0;
    this.recentCallSignatures = [];
  }

  public shouldEscalate(): boolean {
    return (
      this.consecutiveFailures >= this.maxConsecutiveFailures ||
      this.totalFailures >= this.maxTotalFailures ||
      this.isRepeatingPattern()
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

  private isRepeatingPattern(): boolean {
    if (this.recentCallSignatures.length < this.repetitionThreshold) {
      return false;
    }

    const lastSignature = this.recentCallSignatures[this.recentCallSignatures.length - 1];
    if (!lastSignature) {
      return false;
    }

    let matches = 0;
    for (const signature of this.recentCallSignatures) {
      if (signature === lastSignature) {
        matches += 1;
      }
    }

    return matches >= this.repetitionThreshold;
  }

  private toSignature(name: string, input: Record<string, unknown>): string {
    return `${name}:${stableStringify(input)}`;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const serialized = entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`);
  return `{${serialized.join(",")}}`;
}
