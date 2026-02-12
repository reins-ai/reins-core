import type { PerformanceMetrics } from "./types";

const MAX_MEASUREMENTS = 100;

export class MetricsTracker {
  private readonly measurements: PerformanceMetrics[] = [];

  record(metrics: PerformanceMetrics): void {
    this.measurements.push({
      ...metrics,
      timestamp: new Date(metrics.timestamp),
    });

    if (this.measurements.length > MAX_MEASUREMENTS) {
      this.measurements.splice(0, this.measurements.length - MAX_MEASUREMENTS);
    }
  }

  getAverage(modelId?: string): {
    avgTokensPerSecond: number;
    avgLatencyMs: number;
    sampleCount: number;
  } {
    const samples =
      modelId === undefined
        ? this.measurements
        : this.measurements.filter((entry) => entry.modelId === modelId);

    if (samples.length === 0) {
      return {
        avgTokensPerSecond: 0,
        avgLatencyMs: 0,
        sampleCount: 0,
      };
    }

    const totals = samples.reduce(
      (acc, sample) => {
        return {
          tokensPerSecond: acc.tokensPerSecond + sample.tokensPerSecond,
          latencyMs: acc.latencyMs + sample.latencyMs,
        };
      },
      { tokensPerSecond: 0, latencyMs: 0 },
    );

    return {
      avgTokensPerSecond: totals.tokensPerSecond / samples.length,
      avgLatencyMs: totals.latencyMs / samples.length,
      sampleCount: samples.length,
    };
  }

  getRecent(limit?: number): PerformanceMetrics[] {
    const normalizedLimit =
      limit === undefined ? this.measurements.length : Math.max(0, Math.floor(limit));

    return this.measurements
      .slice(-normalizedLimit)
      .reverse()
      .map((entry) => ({
        ...entry,
        timestamp: new Date(entry.timestamp),
      }));
  }

  clear(): void {
    this.measurements.length = 0;
  }
}
