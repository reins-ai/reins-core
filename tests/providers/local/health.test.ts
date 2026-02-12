import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { HealthChecker } from "../../../src/providers/local/health";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("HealthChecker", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns available and unavailable states", async () => {
    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    };

    const checker = new HealthChecker("http://localhost:11434");
    const available = await checker.check();

    expect(available.status).toBe("available");
    expect(available.latencyMs).toBeGreaterThanOrEqual(0);

    globalThis.fetch = async () => {
      return new Response("server error", { status: 500 });
    };

    const unavailable = await checker.check();
    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.error).toContain("500");
  });

  it("measures latency for successful probes", async () => {
    globalThis.fetch = async () => {
      await delay(20);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    };

    const checker = new HealthChecker("http://localhost:8000", 1_000);
    const result = await checker.check();

    expect(result.status).toBe("available");
    expect(result.latencyMs).toBeGreaterThanOrEqual(10);
  });

  it("supports polling lifecycle with startPolling and stopPolling", async () => {
    let callCount = 0;

    globalThis.fetch = async () => {
      callCount += 1;
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    };

    const checker = new HealthChecker("http://localhost:11434");
    const statusChanges: string[] = [];

    checker.onStatusChange((health) => {
      statusChanges.push(health.status);
    });

    checker.startPolling(15);
    await delay(50);
    checker.stopPolling();

    const callsAfterStop = callCount;
    await delay(40);

    expect(callCount).toBeGreaterThan(0);
    expect(callCount).toBe(callsAfterStop);
    expect(statusChanges).toContain("available");
  });
});
