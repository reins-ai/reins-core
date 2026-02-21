import { describe, expect, it, mock } from "bun:test";

import { OAuthTokenKeepaliveService } from "../../../src/providers/oauth/keepalive";
import type { OAuthKeepaliveOptions } from "../../../src/providers/oauth/keepalive";
import { AuthError } from "../../../src/errors";
import { ok, err } from "../../../src/result";
import type { OAuthTokens } from "../../../src/providers/oauth/types";

function makeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    scope: "org:create_api_key",
    tokenType: "Bearer",
    ...overrides,
  };
}

interface ScheduledCall {
  fn: () => void;
  ms: number;
}

/**
 * Flush microtask queue so fire-and-forget `void this.doRefresh()` chains
 * settle before assertions run.
 */
async function flush(): Promise<void> {
  // Two rounds of microtask flushing covers doRefresh → scheduleNextRefresh chains
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

function createTestHarness(overrides: Partial<OAuthKeepaliveOptions> = {}) {
  let currentTime = 1_000_000;
  const scheduled: ScheduledCall[] = [];
  let timerIdCounter = 1;

  const getOrRefreshToken = mock(() => Promise.resolve(ok("new-access-token")));
  const loadCurrentTokens = mock(() =>
    Promise.resolve(
      makeTokens({
        expiresAt: new Date(currentTime + 60 * 60 * 1000),
      }),
    ),
  );

  const nowFn = () => currentTime;
  const scheduleFn = (fn: () => void, ms: number) => {
    scheduled.push({ fn, ms });
    return timerIdCounter++ as unknown as ReturnType<typeof setTimeout>;
  };

  const service = new OAuthTokenKeepaliveService({
    provider: "anthropic",
    getOrRefreshToken,
    loadCurrentTokens,
    now: nowFn,
    schedule: scheduleFn,
    ...overrides,
  });

  return {
    service,
    getOrRefreshToken,
    loadCurrentTokens,
    scheduled,
    setTime: (t: number) => { currentTime = t; },
    getTime: () => currentTime,
  };
}

describe("OAuthTokenKeepaliveService", () => {
  describe("start()", () => {
    it("schedules refresh at (expiresAt - bufferMs) delay when tokens exist with refresh token", async () => {
      const harness = createTestHarness();
      // Token expires at currentTime + 1h, buffer is 5min
      // Expected delay: 1h - 5min = 55min = 3_300_000ms
      await harness.service.start();

      expect(harness.loadCurrentTokens).toHaveBeenCalledTimes(1);
      expect(harness.scheduled).toHaveLength(1);
      expect(harness.scheduled[0]!.ms).toBe(55 * 60 * 1000);
    });

    it("does NOT schedule when no tokens exist", async () => {
      const harness = createTestHarness({
        loadCurrentTokens: () => Promise.resolve(null),
      });

      await harness.service.start();

      expect(harness.scheduled).toHaveLength(0);
    });

    it("does NOT schedule when tokens have no refresh token", async () => {
      const harness = createTestHarness({
        loadCurrentTokens: () =>
          Promise.resolve(
            makeTokens({
              refreshToken: undefined,
              expiresAt: new Date(1_000_000 + 60 * 60 * 1000),
            }),
          ),
      });

      await harness.service.start();

      expect(harness.scheduled).toHaveLength(0);
    });

    it("is idempotent — calling start() twice does not double-schedule", async () => {
      const harness = createTestHarness();

      await harness.service.start();
      await harness.service.start();

      // Only one schedule call from the first start()
      expect(harness.scheduled).toHaveLength(1);
    });

    it("uses delay of 0 when token is already past the buffer threshold", async () => {
      const harness = createTestHarness({
        loadCurrentTokens: () =>
          Promise.resolve(
            makeTokens({
              expiresAt: new Date(1_000_000 + 2 * 60 * 1000), // expires in 2min, buffer is 5min
            }),
          ),
      });

      await harness.service.start();

      expect(harness.scheduled).toHaveLength(1);
      expect(harness.scheduled[0]!.ms).toBe(0);
    });
  });

  describe("successful refresh", () => {
    it("calls getOrRefreshToken and then schedules the next refresh", async () => {
      const harness = createTestHarness();

      await harness.service.start();
      expect(harness.scheduled).toHaveLength(1);

      // Fire the scheduled timer callback (void doRefresh runs async)
      harness.scheduled[0]!.fn();
      await flush();

      expect(harness.getOrRefreshToken).toHaveBeenCalledTimes(1);
      // After success, scheduleNextRefresh is called → loadCurrentTokens again → new schedule
      expect(harness.loadCurrentTokens).toHaveBeenCalledTimes(2);
      expect(harness.scheduled).toHaveLength(2);
    });

    it("resets retryCount after a successful refresh", async () => {
      // First make it fail, then succeed
      let callCount = 0;
      const harness = createTestHarness({
        getOrRefreshToken: () => {
          callCount++;
          if (callCount === 1) {
            return Promise.resolve(err(new AuthError("temporary failure")));
          }
          return Promise.resolve(ok("new-token"));
        },
      });

      await harness.service.start();

      // Fire first timer → triggers doRefresh → fails → scheduleRetry
      harness.scheduled[0]!.fn();
      await flush();
      expect(harness.scheduled).toHaveLength(2);
      // Retry delay should be RETRY_DELAYS_MS[0] = 60_000
      expect(harness.scheduled[1]!.ms).toBe(60_000);

      // Fire retry timer → triggers doRefresh → succeeds → scheduleNextRefresh
      harness.scheduled[1]!.fn();
      await flush();
      expect(harness.scheduled).toHaveLength(3);
      // After success, next schedule should be based on token expiry, not retry delay
      expect(harness.scheduled[2]!.ms).toBe(55 * 60 * 1000);
    });
  });

  describe("failed refresh", () => {
    it("schedules retry with first backoff delay when result.ok is false", async () => {
      const harness = createTestHarness({
        getOrRefreshToken: () => Promise.resolve(err(new AuthError("refresh failed"))),
      });

      await harness.service.start();
      harness.scheduled[0]!.fn();
      await flush();

      expect(harness.scheduled).toHaveLength(2);
      expect(harness.scheduled[1]!.ms).toBe(60_000); // 1 minute
    });

    it("increments retryCount and uses correct delay index for successive failures", async () => {
      const harness = createTestHarness({
        getOrRefreshToken: () => Promise.resolve(err(new AuthError("refresh failed"))),
      });

      await harness.service.start();

      // Failure 1 → retry delay index 0 = 60_000
      harness.scheduled[0]!.fn();
      await flush();
      expect(harness.scheduled[1]!.ms).toBe(60_000);

      // Failure 2 → retry delay index 1 = 120_000
      harness.scheduled[1]!.fn();
      await flush();
      expect(harness.scheduled[2]!.ms).toBe(2 * 60_000);

      // Failure 3 → retry delay index 2 = 300_000
      harness.scheduled[2]!.fn();
      await flush();
      expect(harness.scheduled[3]!.ms).toBe(5 * 60_000);

      // Failure 4 → retry delay index 3 = 600_000
      harness.scheduled[3]!.fn();
      await flush();
      expect(harness.scheduled[4]!.ms).toBe(10 * 60_000);

      // Failure 5 → retry delay index 4 = 1_800_000 (cap)
      harness.scheduled[4]!.fn();
      await flush();
      expect(harness.scheduled[5]!.ms).toBe(30 * 60_000);

      // Failure 6 → still capped at index 4 = 1_800_000
      harness.scheduled[5]!.fn();
      await flush();
      expect(harness.scheduled[6]!.ms).toBe(30 * 60_000);
    });

    it("schedules retry when getOrRefreshToken throws an unexpected error", async () => {
      const harness = createTestHarness({
        getOrRefreshToken: () => Promise.reject(new Error("network error")),
      });

      await harness.service.start();
      harness.scheduled[0]!.fn();
      await flush();

      expect(harness.scheduled).toHaveLength(2);
      expect(harness.scheduled[1]!.ms).toBe(60_000);
    });
  });

  describe("stop()", () => {
    it("clears the timer and prevents further scheduling", async () => {
      const harness = createTestHarness();

      await harness.service.start();
      expect(harness.scheduled).toHaveLength(1);

      harness.service.stop();

      // Fire the timer callback after stop — doRefresh should be a no-op
      harness.scheduled[0]!.fn();
      await flush();

      // No new schedules should have been added
      expect(harness.getOrRefreshToken).not.toHaveBeenCalled();
      expect(harness.scheduled).toHaveLength(1);
    });

    it("prevents scheduleRetry from scheduling after stop", async () => {
      const harness = createTestHarness({
        getOrRefreshToken: async () => {
          // Stop the service mid-refresh
          harness.service.stop();
          return err(new AuthError("fail"));
        },
      });

      await harness.service.start();
      harness.scheduled[0]!.fn();
      await flush();

      // Only the initial schedule from start(), no retry schedule
      expect(harness.scheduled).toHaveLength(1);
    });
  });

  describe("concurrent refresh guard", () => {
    it("reschedules instead of refreshing when a refresh is already in progress", async () => {
      let resolveRefresh: ((value: { ok: true; value: string }) => void) | null = null;
      const harness = createTestHarness({
        getOrRefreshToken: () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      });

      await harness.service.start();

      // Start the first refresh (it will hang on the unresolved promise)
      harness.scheduled[0]!.fn();
      // Let the doRefresh start and set isRefreshing = true
      await flush();

      // getOrRefreshToken was called but hasn't resolved yet
      expect(resolveRefresh).not.toBeNull();

      // Resolve the hanging refresh
      resolveRefresh!({ ok: true, value: "new-token" });
      await flush();

      // After success: loadCurrentTokens called again, new schedule added
      expect(harness.scheduled).toHaveLength(2);
    });
  });

  describe("loadCurrentTokens error handling", () => {
    it("does not schedule when loadCurrentTokens throws", async () => {
      const harness = createTestHarness({
        loadCurrentTokens: () => Promise.reject(new Error("storage error")),
      });

      await harness.service.start();

      expect(harness.scheduled).toHaveLength(0);
    });
  });
});
