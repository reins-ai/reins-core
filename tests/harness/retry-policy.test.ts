import { describe, expect, it } from "bun:test";

import {
  calculateBackoff,
  classifyError,
  parseRetryAfter,
  retry,
  RetryExhaustedError,
} from "../../src/harness";
import { ProviderError } from "../../src/errors";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeHttpError(status: number, headers?: Record<string, string>): Error & { status: number; headers?: Record<string, string> } {
  const error = new Error(`HTTP ${status}`) as Error & { status: number; headers?: Record<string, string> };
  error.status = status;
  if (headers) {
    error.headers = headers;
  }
  return error;
}

function makeNetworkError(message: string): Error {
  return new Error(message);
}

/** Instant sleep for fast tests. */
async function instantSleep(_ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}

// ---------------------------------------------------------------------------
// classifyError
// ---------------------------------------------------------------------------

describe("classifyError", () => {
  describe("retryable HTTP status codes", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      it(`classifies HTTP ${status} as retryable`, () => {
        const error = makeHttpError(status);
        const result = classifyError(error);
        expect(result.retryable).toBe(true);
        expect(result.reason).toContain(String(status));
      });
    }
  });

  describe("non-retryable HTTP status codes", () => {
    for (const status of [400, 401, 403, 404, 405, 409, 422]) {
      it(`classifies HTTP ${status} as non-retryable`, () => {
        const error = makeHttpError(status);
        const result = classifyError(error);
        expect(result.retryable).toBe(false);
        expect(result.reason).toContain(String(status));
      });
    }
  });

  describe("network/transient errors", () => {
    const transientMessages = [
      "ECONNREFUSED",
      "ECONNRESET",
      "ETIMEDOUT",
      "ENETUNREACH",
      "EHOSTUNREACH",
      "ENOTFOUND",
      "socket hang up",
      "network error occurred",
      "request timeout",
      "connection refused by server",
      "DNS resolution failed",
      "fetch failed",
    ];

    for (const message of transientMessages) {
      it(`classifies "${message}" as retryable`, () => {
        const error = makeNetworkError(message);
        const result = classifyError(error);
        expect(result.retryable).toBe(true);
      });
    }
  });

  it("classifies unknown errors as non-retryable", () => {
    const error = new Error("Something unexpected happened");
    const result = classifyError(error);
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain("Unknown");
  });

  it("classifies non-Error values as non-retryable", () => {
    const result = classifyError("string error");
    expect(result.retryable).toBe(false);
  });

  it("classifies null as non-retryable", () => {
    const result = classifyError(null);
    expect(result.retryable).toBe(false);
  });

  it("extracts Retry-After header from error.headers object", () => {
    const error = makeHttpError(429, { "Retry-After": "5" });
    const result = classifyError(error);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(5_000);
  });

  it("extracts Retry-After from Headers instance", () => {
    const headers = new Headers({ "Retry-After": "10" });
    const error = Object.assign(new Error("rate limited"), { status: 429, headers });
    const result = classifyError(error);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(10_000);
  });

  it("extracts Retry-After from response.headers", () => {
    const error = Object.assign(new Error("rate limited"), {
      status: 429,
      response: { headers: { "Retry-After": "3" } },
    });
    const result = classifyError(error);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterMs).toBe(3_000);
  });

  it("extracts status from statusCode property", () => {
    const error = Object.assign(new Error("bad gateway"), { statusCode: 502 });
    const result = classifyError(error);
    expect(result.retryable).toBe(true);
  });

  it("prioritizes non-retryable status over transient message", () => {
    const error = Object.assign(new Error("connection timeout"), { status: 401 });
    const result = classifyError(error);
    expect(result.retryable).toBe(false);
    expect(result.reason).toContain("401");
  });
});

// ---------------------------------------------------------------------------
// parseRetryAfter
// ---------------------------------------------------------------------------

describe("parseRetryAfter", () => {
  it("parses integer seconds", () => {
    expect(parseRetryAfter("5")).toBe(5_000);
  });

  it("parses zero seconds", () => {
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses fractional seconds (rounds up)", () => {
    expect(parseRetryAfter("1.5")).toBe(1_500);
  });

  it("parses HTTP-date in the future", () => {
    const futureDate = new Date(Date.now() + 10_000).toUTCString();
    const result = parseRetryAfter(futureDate, () => Date.now());
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(11_000);
  });

  it("returns 0 for HTTP-date in the past", () => {
    const pastDate = new Date(Date.now() - 10_000).toUTCString();
    const result = parseRetryAfter(pastDate, () => Date.now());
    expect(result).toBe(0);
  });

  it("returns undefined for null", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(parseRetryAfter("")).toBeUndefined();
  });

  it("returns undefined for unparseable value", () => {
    expect(parseRetryAfter("not-a-date-or-number")).toBeUndefined();
  });

  it("handles whitespace-padded values", () => {
    expect(parseRetryAfter("  10  ")).toBe(10_000);
  });
});

// ---------------------------------------------------------------------------
// calculateBackoff
// ---------------------------------------------------------------------------

describe("calculateBackoff", () => {
  it("returns base delay for attempt 0 without jitter", () => {
    const delay = calculateBackoff(0, { jitter: false, baseDelayMs: 1_000 });
    expect(delay).toBe(1_000);
  });

  it("doubles delay for each subsequent attempt", () => {
    const d0 = calculateBackoff(0, { jitter: false, baseDelayMs: 1_000 });
    const d1 = calculateBackoff(1, { jitter: false, baseDelayMs: 1_000 });
    const d2 = calculateBackoff(2, { jitter: false, baseDelayMs: 1_000 });
    const d3 = calculateBackoff(3, { jitter: false, baseDelayMs: 1_000 });

    expect(d0).toBe(1_000);
    expect(d1).toBe(2_000);
    expect(d2).toBe(4_000);
    expect(d3).toBe(8_000);
  });

  it("caps delay at maxDelayMs", () => {
    const delay = calculateBackoff(20, { jitter: false, baseDelayMs: 1_000, maxDelayMs: 30_000 });
    expect(delay).toBe(30_000);
  });

  it("adds jitter between 0-25% when enabled", () => {
    // With randomFn returning 1.0, jitter should be exactly 25%
    const delay = calculateBackoff(0, {
      jitter: true,
      baseDelayMs: 1_000,
      randomFn: () => 1.0,
    });
    expect(delay).toBe(1_250);
  });

  it("adds no jitter when randomFn returns 0", () => {
    const delay = calculateBackoff(0, {
      jitter: true,
      baseDelayMs: 1_000,
      randomFn: () => 0,
    });
    expect(delay).toBe(1_000);
  });

  it("uses default base and max delay", () => {
    const delay = calculateBackoff(0, { jitter: false });
    expect(delay).toBe(1_000);

    const capped = calculateBackoff(100, { jitter: false });
    expect(capped).toBe(30_000);
  });
});

// ---------------------------------------------------------------------------
// retry
// ---------------------------------------------------------------------------

describe("retry", () => {
  it("returns result on first success", async () => {
    const result = await retry(() => Promise.resolve(42), {
      sleepFn: instantSleep,
    });
    expect(result).toBe(42);
  });

  it("retries on retryable error and succeeds", async () => {
    let calls = 0;
    const result = await retry(
      () => {
        calls++;
        if (calls < 3) {
          throw makeHttpError(500);
        }
        return Promise.resolve("ok");
      },
      { maxAttempts: 3, sleepFn: instantSleep, jitter: false },
    );

    expect(result).toBe("ok");
    expect(calls).toBe(3);
  });

  it("throws immediately on non-retryable error", async () => {
    let calls = 0;
    try {
      await retry(
        () => {
          calls++;
          throw makeHttpError(401);
        },
        { maxAttempts: 3, sleepFn: instantSleep },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(calls).toBe(1);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("401");
    }
  });

  it("throws RetryExhaustedError when max attempts exceeded", async () => {
    let calls = 0;
    try {
      await retry(
        () => {
          calls++;
          throw makeHttpError(500);
        },
        { maxAttempts: 3, sleepFn: instantSleep, jitter: false },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(calls).toBe(3);
      expect(error).toBeInstanceOf(RetryExhaustedError);
      const retryError = error as RetryExhaustedError;
      expect(retryError.attempts).toBe(3);
      expect(retryError.code).toBe("RETRY_EXHAUSTED");
      expect(retryError.lastError).toBeInstanceOf(Error);
    }
  });

  it("throws RetryExhaustedError when max duration exceeded", async () => {
    let clock = 0;
    const now = () => clock;

    try {
      await retry(
        () => {
          clock += 25_000; // Each attempt takes 25s
          throw makeHttpError(500);
        },
        {
          maxAttempts: 10,
          maxDurationMs: 60_000,
          sleepFn: instantSleep,
          jitter: false,
          now,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError);
      expect((error as RetryExhaustedError).message).toContain("duration");
    }
  });

  it("throws RetryExhaustedError when delay would exceed duration cap", async () => {
    let clock = 0;
    const now = () => clock;

    try {
      await retry(
        () => {
          clock += 1_000;
          throw makeHttpError(500);
        },
        {
          maxAttempts: 10,
          maxDurationMs: 5_000,
          baseDelayMs: 10_000, // Delay alone exceeds remaining budget
          sleepFn: instantSleep,
          jitter: false,
          now,
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError);
      expect((error as RetryExhaustedError).message).toContain("duration");
    }
  });

  it("respects Retry-After header over calculated backoff", async () => {
    const delays: number[] = [];
    let calls = 0;

    await retry(
      () => {
        calls++;
        if (calls < 2) {
          throw makeHttpError(429, { "Retry-After": "7" });
        }
        return Promise.resolve("ok");
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        jitter: false,
        sleepFn: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(delays).toEqual([7_000]);
  });

  it("uses calculated backoff when no Retry-After present", async () => {
    const delays: number[] = [];
    let calls = 0;

    await retry(
      () => {
        calls++;
        if (calls < 3) {
          throw makeHttpError(500);
        }
        return Promise.resolve("ok");
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        jitter: false,
        sleepFn: async (ms) => {
          delays.push(ms);
        },
      },
    );

    // attempt 0 fails → backoff(0) = 1000ms, attempt 1 fails → backoff(1) = 2000ms
    expect(delays).toEqual([1_000, 2_000]);
  });

  it("calls onRetry callback before each retry", async () => {
    const retryLog: Array<{ attempt: number; delay: number; message: string }> = [];
    let calls = 0;

    await retry(
      () => {
        calls++;
        if (calls < 3) {
          throw makeHttpError(502);
        }
        return Promise.resolve("ok");
      },
      {
        maxAttempts: 3,
        baseDelayMs: 1_000,
        jitter: false,
        sleepFn: instantSleep,
        onRetry: (attempt, delay, error) => {
          retryLog.push({ attempt, delay, message: error.message });
        },
      },
    );

    expect(retryLog).toHaveLength(2);
    expect(retryLog[0]!.attempt).toBe(1);
    expect(retryLog[0]!.delay).toBe(1_000);
    expect(retryLog[1]!.attempt).toBe(2);
    expect(retryLog[1]!.delay).toBe(2_000);
  });

  it("throws on abort signal before first attempt", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");

    try {
      await retry(() => Promise.resolve("ok"), {
        signal: controller.signal,
        sleepFn: instantSleep,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String(error)).toContain("cancelled");
    }
  });

  it("throws on abort signal during sleep", async () => {
    const controller = new AbortController();
    let calls = 0;

    try {
      await retry(
        () => {
          calls++;
          throw makeHttpError(500);
        },
        {
          maxAttempts: 5,
          signal: controller.signal,
          sleepFn: async (_ms, signal) => {
            // Simulate abort during sleep
            controller.abort("user cancelled");
            if (signal?.aborted) {
              throw signal.reason ?? new DOMException("Aborted", "AbortError");
            }
          },
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(calls).toBe(1);
      expect(String(error)).toContain("cancelled");
    }
  });

  it("handles non-Error thrown values", async () => {
    let calls = 0;
    try {
      await retry(
        () => {
          calls++;
          throw "string error"; // eslint-disable-line no-throw-literal
        },
        { maxAttempts: 1, sleepFn: instantSleep },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(calls).toBe(1);
      // String errors are non-retryable (unknown type), so thrown immediately
      expect(error).toBeInstanceOf(ProviderError);
    }
  });

  it("retries network errors with exponential backoff", async () => {
    const delays: number[] = [];
    let calls = 0;

    await retry(
      () => {
        calls++;
        if (calls < 3) {
          throw makeNetworkError("ECONNREFUSED");
        }
        return Promise.resolve("connected");
      },
      {
        maxAttempts: 5,
        baseDelayMs: 500,
        jitter: false,
        sleepFn: async (ms) => {
          delays.push(ms);
        },
      },
    );

    expect(calls).toBe(3);
    expect(delays).toEqual([500, 1_000]);
  });

  it("works with single attempt (no retries)", async () => {
    const result = await retry(() => Promise.resolve("once"), {
      maxAttempts: 1,
      sleepFn: instantSleep,
    });
    expect(result).toBe("once");
  });

  it("throws immediately with single attempt on retryable error", async () => {
    try {
      await retry(
        () => {
          throw makeHttpError(500);
        },
        { maxAttempts: 1, sleepFn: instantSleep },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError);
      expect((error as RetryExhaustedError).attempts).toBe(1);
    }
  });

  it("preserves the original error in RetryExhaustedError", async () => {
    const originalError = makeHttpError(503);

    try {
      await retry(
        () => {
          throw originalError;
        },
        { maxAttempts: 2, sleepFn: instantSleep, jitter: false },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError);
      const retryError = error as RetryExhaustedError;
      expect(retryError.lastError).toBe(originalError);
      expect(retryError.cause).toBe(originalError);
    }
  });
});
