export interface BenchmarkResult {
  name: string;
  iterations: number;
  totalMs: number;
  averageMs: number;
  minMs: number;
  maxMs: number;
  p95Ms: number;
  opsPerSecond: number;
}

const DEFAULT_ITERATIONS = 100;

function resolveIterations(iterations?: number): number {
  if (iterations === undefined) {
    return DEFAULT_ITERATIONS;
  }

  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new RangeError("iterations must be a positive integer");
  }

  return iterations;
}

function summarize(name: string, durations: number[]): BenchmarkResult {
  const iterations = durations.length;
  const sorted = [...durations].sort((left, right) => left - right);
  const totalMs = durations.reduce((accumulator, duration) => accumulator + duration, 0);
  const averageMs = totalMs / iterations;
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  const p95Ms = sorted[p95Index] ?? 0;
  const opsPerSecond = totalMs <= 0 ? Number.POSITIVE_INFINITY : (iterations * 1000) / totalMs;

  return {
    name,
    iterations,
    totalMs,
    averageMs,
    minMs,
    maxMs,
    p95Ms,
    opsPerSecond,
  };
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    return "inf";
  }

  return value.toFixed(3);
}

export function benchmark(name: string, fn: () => void, iterations?: number): BenchmarkResult {
  const runCount = resolveIterations(iterations);
  const durations: number[] = [];

  for (let index = 0; index < runCount; index += 1) {
    const start = performance.now();
    fn();
    durations.push(performance.now() - start);
  }

  return summarize(name, durations);
}

export async function benchmarkAsync(
  name: string,
  fn: () => Promise<void>,
  iterations?: number,
): Promise<BenchmarkResult> {
  const runCount = resolveIterations(iterations);
  const durations: number[] = [];

  for (let index = 0; index < runCount; index += 1) {
    const start = performance.now();
    await fn();
    durations.push(performance.now() - start);
  }

  return summarize(name, durations);
}

export function formatBenchmark(result: BenchmarkResult): string {
  return [
    `${result.name} (${result.iterations} iterations)`,
    `avg=${formatNumber(result.averageMs)}ms`,
    `p95=${formatNumber(result.p95Ms)}ms`,
    `min=${formatNumber(result.minMs)}ms`,
    `max=${formatNumber(result.maxMs)}ms`,
    `ops/s=${formatNumber(result.opsPerSecond)}`,
  ].join(" | ");
}
