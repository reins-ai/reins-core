import { describe, expect, it } from "bun:test";

import { MetricsTracker } from "../../../src/providers/local/metrics";

describe("MetricsTracker", () => {
  it("records metrics and computes averages", () => {
    const tracker = new MetricsTracker();

    tracker.record({
      modelId: "m1",
      tokensPerSecond: 50,
      latencyMs: 200,
      timestamp: new Date("2026-02-10T00:00:00Z"),
    });
    tracker.record({
      modelId: "m1",
      tokensPerSecond: 70,
      latencyMs: 300,
      timestamp: new Date("2026-02-10T00:00:01Z"),
    });

    const average = tracker.getAverage();

    expect(average.sampleCount).toBe(2);
    expect(average.avgTokensPerSecond).toBe(60);
    expect(average.avgLatencyMs).toBe(250);
  });

  it("keeps only the last 100 measurements", () => {
    const tracker = new MetricsTracker();

    for (let i = 1; i <= 105; i += 1) {
      tracker.record({
        modelId: "rolling",
        tokensPerSecond: i,
        latencyMs: i * 2,
        timestamp: new Date(2026, 1, 10, 0, 0, i),
      });
    }

    const recent = tracker.getRecent();
    expect(recent).toHaveLength(100);
    expect(recent[0]?.tokensPerSecond).toBe(105);
    expect(recent[99]?.tokensPerSecond).toBe(6);
  });

  it("returns recent metrics with optional limit", () => {
    const tracker = new MetricsTracker();

    tracker.record({
      modelId: "m1",
      tokensPerSecond: 10,
      latencyMs: 100,
      timestamp: new Date("2026-02-10T00:00:00Z"),
    });
    tracker.record({
      modelId: "m1",
      tokensPerSecond: 20,
      latencyMs: 200,
      timestamp: new Date("2026-02-10T00:00:01Z"),
    });
    tracker.record({
      modelId: "m2",
      tokensPerSecond: 30,
      latencyMs: 300,
      timestamp: new Date("2026-02-10T00:00:02Z"),
    });

    const limited = tracker.getRecent(2);
    expect(limited).toHaveLength(2);
    expect(limited[0]?.modelId).toBe("m2");
    expect(limited[1]?.modelId).toBe("m1");
  });

  it("filters averages by model id", () => {
    const tracker = new MetricsTracker();

    tracker.record({
      modelId: "model-a",
      tokensPerSecond: 100,
      latencyMs: 100,
      timestamp: new Date(),
    });
    tracker.record({
      modelId: "model-b",
      tokensPerSecond: 40,
      latencyMs: 400,
      timestamp: new Date(),
    });

    const filtered = tracker.getAverage("model-a");
    expect(filtered.sampleCount).toBe(1);
    expect(filtered.avgTokensPerSecond).toBe(100);
    expect(filtered.avgLatencyMs).toBe(100);

    tracker.clear();
    expect(tracker.getRecent()).toEqual([]);
  });
});
