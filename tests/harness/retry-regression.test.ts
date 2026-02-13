import { describe, expect, it } from "bun:test";

import {
  classifyError,
  retry,
  RetryExhaustedError,
} from "../../src/harness";

function makeHttpError(
  status: number,
  headers?: Record<string, string>,
): Error & { status: number; headers?: Record<string, string> } {
  const error = new Error(`HTTP ${status}`) as Error & {
    status: number;
    headers?: Record<string, string>;
  };
  error.status = status;
  if (headers) {
    error.headers = headers;
  }
  return error;
}

async function instantSleep(_ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}

describe("retry regression: retry chain scenarios", () => {
  it("retries through a chain of different retryable errors", async () => {
    const errors = [
      makeHttpError(429, { "Retry-After": "1" }),
      makeHttpError(502),
      makeHttpError(503),
    ];
    let callIndex = 0;

    const result = await retry(
      () => {
        if (callIndex < errors.length) {
          const error = errors[callIndex];
          callIndex += 1;
          throw error;
        }
        return Promise.resolve("success after chain");
      },
      {
        maxAttempts: 5,
        sleepFn: instantSleep,
        jitter: false,
      },
    );

    expect(result).toBe("success after chain");
    expect(callIndex).toBe(3);
  });

  it("exhausts retries through a chain of mixed retryable errors", async () => {
    let calls = 0;

    try {
      await retry(
        () => {
          calls += 1;
          if (calls % 2 === 1) {
            throw makeHttpError(429);
          }
          throw makeHttpError(500);
        },
        {
          maxAttempts: 4,
          sleepFn: instantSleep,
          jitter: false,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError);
      expect(calls).toBe(4);
    }
  });

  it("stops retry chain immediately when non-retryable error appears", async () => {
    const errorSequence = [
      makeHttpError(500),
      makeHttpError(401), // non-retryable
    ];
    let callIndex = 0;

    try {
      await retry(
        () => {
          const error = errorSequence[callIndex];
          callIndex += 1;
          throw error;
        },
        {
          maxAttempts: 5,
          sleepFn: instantSleep,
          jitter: false,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(callIndex).toBe(2);
      expect((error as Error).message).toContain("401");
    }
  });
});

describe("retry regression: abort-during-retry", () => {
  it("aborts between retry attempts via signal", async () => {
    const controller = new AbortController();
    let calls = 0;
    const delays: number[] = [];

    try {
      await retry(
        () => {
          calls += 1;
          throw makeHttpError(500);
        },
        {
          maxAttempts: 10,
          signal: controller.signal,
          jitter: false,
          sleepFn: async (ms, signal) => {
            delays.push(ms);
            // Abort after first retry sleep
            if (delays.length === 1) {
              controller.abort("user cancelled during retry");
            }
            if (signal?.aborted) {
              throw signal.reason ?? new DOMException("Aborted", "AbortError");
            }
          },
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(calls).toBeLessThanOrEqual(2);
      expect(String(error)).toContain("cancelled");
    }
  });

  it("respects abort signal set before retry starts", async () => {
    const controller = new AbortController();
    controller.abort("pre-cancelled");

    let calls = 0;
    try {
      await retry(
        () => {
          calls += 1;
          return Promise.resolve("should not reach");
        },
        {
          maxAttempts: 5,
          signal: controller.signal,
          sleepFn: instantSleep,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(calls).toBe(0);
      expect(String(error)).toContain("pre-cancelled");
    }
  });
});

describe("retry regression: backoff timing", () => {
  it("records correct exponential backoff delays across attempts", async () => {
    const delays: number[] = [];
    let calls = 0;

    try {
      await retry(
        () => {
          calls += 1;
          throw makeHttpError(500);
        },
        {
          maxAttempts: 5,
          baseDelayMs: 100,
          maxDelayMs: 10_000,
          jitter: false,
          sleepFn: async (ms) => {
            delays.push(ms);
          },
        },
      );
    } catch {
      // Expected
    }

    // Exponential: 100, 200, 400, 800
    expect(delays).toEqual([100, 200, 400, 800]);
    expect(calls).toBe(5);
  });

  it("caps backoff at maxDelayMs", async () => {
    const delays: number[] = [];
    let calls = 0;

    try {
      await retry(
        () => {
          calls += 1;
          throw makeHttpError(500);
        },
        {
          maxAttempts: 6,
          baseDelayMs: 1_000,
          maxDelayMs: 3_000,
          jitter: false,
          sleepFn: async (ms) => {
            delays.push(ms);
          },
        },
      );
    } catch {
      // Expected
    }

    // 1000, 2000, 3000 (capped), 3000 (capped), 3000 (capped)
    expect(delays).toEqual([1_000, 2_000, 3_000, 3_000, 3_000]);
  });

  it("uses Retry-After header delay instead of calculated backoff", async () => {
    const delays: number[] = [];
    let calls = 0;

    await retry(
      () => {
        calls += 1;
        if (calls === 1) {
          throw makeHttpError(429, { "Retry-After": "3" });
        }
        return Promise.resolve("ok");
      },
      {
        maxAttempts: 3,
        baseDelayMs: 100,
        jitter: false,
        sleepFn: async (ms) => {
          delays.push(ms);
        },
      },
    );

    // Should use Retry-After (3000ms) instead of calculated (100ms)
    expect(delays).toEqual([3_000]);
  });

  it("onRetry callback receives correct attempt number and delay", async () => {
    const retryLog: Array<{ attempt: number; delay: number }> = [];
    let calls = 0;

    try {
      await retry(
        () => {
          calls += 1;
          throw makeHttpError(503);
        },
        {
          maxAttempts: 4,
          baseDelayMs: 200,
          jitter: false,
          sleepFn: instantSleep,
          onRetry: (attempt, delay) => {
            retryLog.push({ attempt, delay });
          },
        },
      );
    } catch {
      // Expected
    }

    expect(retryLog).toEqual([
      { attempt: 1, delay: 200 },
      { attempt: 2, delay: 400 },
      { attempt: 3, delay: 800 },
    ]);
  });
});

describe("retry regression: duration cap interactions", () => {
  it("enforces duration cap even when attempts remain", async () => {
    let clock = 0;
    const now = () => clock;
    let calls = 0;

    try {
      await retry(
        () => {
          calls += 1;
          clock += 20_000;
          throw makeHttpError(500);
        },
        {
          maxAttempts: 100,
          maxDurationMs: 50_000,
          sleepFn: instantSleep,
          jitter: false,
          now,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError);
      expect((error as RetryExhaustedError).message).toContain("duration");
      expect(calls).toBeLessThan(100);
    }
  });

  it("succeeds just before duration cap is reached", async () => {
    let clock = 0;
    const now = () => clock;
    let calls = 0;

    const result = await retry(
      () => {
        calls += 1;
        clock += 10_000;
        if (calls < 3) {
          throw makeHttpError(500);
        }
        return Promise.resolve("just in time");
      },
      {
        maxAttempts: 10,
        maxDurationMs: 60_000,
        sleepFn: instantSleep,
        jitter: false,
        now,
      },
    );

    expect(result).toBe("just in time");
    expect(calls).toBe(3);
  });
});

describe("retry regression: error classification edge cases", () => {
  it("classifies error with both status and network message by status priority", () => {
    // Non-retryable status should win over retryable message
    const error = Object.assign(new Error("ECONNREFUSED"), { status: 403 });
    const result = classifyError(error);
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain("403");
  });

  it("classifies error with retryable status and network message as retryable", () => {
    const error = Object.assign(new Error("timeout"), { status: 502 });
    const result = classifyError(error);
    expect(result.retryable).toBe(true);
    expect(result.reason).toContain("502");
  });

  it("classifies plain object without Error prototype as non-retryable", () => {
    const result = classifyError({ message: "ECONNREFUSED" });
    expect(result.retryable).toBe(false);
  });

  it("classifies error with status outside known ranges as non-retryable", () => {
    const error = Object.assign(new Error("weird"), { status: 418 });
    const result = classifyError(error);
    // 418 is not in retryable or non-retryable sets, and "weird" is not a transient pattern
    expect(result.retryable).toBe(false);
  });
});
