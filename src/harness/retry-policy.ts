import { ProviderError, ReinsError } from "../errors";

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

export interface RetryClassification {
  retryable: boolean;
  retryAfterMs?: number;
  reason: string;
}

/** HTTP status codes that indicate a transient, retryable failure. */
const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);

/** HTTP status codes that indicate a permanent, non-retryable failure. */
const NON_RETRYABLE_STATUS_CODES = new Set([400, 401, 403, 404, 405, 409, 422]);

/**
 * Network-level error message fragments that indicate transient failures.
 * Matched case-insensitively against `error.message`.
 */
const TRANSIENT_ERROR_PATTERNS = [
  "econnrefused",
  "econnreset",
  "etimedout",
  "enetunreach",
  "ehostunreach",
  "enotfound",
  "socket hang up",
  "network",
  "timeout",
  "connection refused",
  "dns",
  "fetch failed",
] as const;

/**
 * Parse the `Retry-After` value from an error or response.
 *
 * Supports two formats per RFC 7231 §7.1.3:
 * - Integer seconds (e.g. `"120"`)
 * - HTTP-date (e.g. `"Wed, 21 Oct 2015 07:28:00 GMT"`)
 *
 * Returns the delay in milliseconds, or `undefined` if the value cannot be
 * parsed or represents a time in the past.
 */
export function parseRetryAfter(
  value: string | undefined | null,
  now: () => number = Date.now,
): number | undefined {
  if (value == null || value.trim() === "") {
    return undefined;
  }

  const trimmed = value.trim();

  // Try integer seconds first
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }

  // Try HTTP-date
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delayMs = dateMs - now();
    return delayMs > 0 ? Math.ceil(delayMs) : 0;
  }

  return undefined;
}

/**
 * Extract an HTTP status code from an error, if available.
 *
 * Looks for a `status`, `statusCode`, or `code` property that resolves to a
 * numeric HTTP status.
 */
function extractStatusCode(error: unknown): number | undefined {
  if (error == null || typeof error !== "object") {
    return undefined;
  }

  const record = error as Record<string, unknown>;

  for (const key of ["status", "statusCode"]) {
    const value = record[key];
    if (typeof value === "number" && value >= 100 && value < 600) {
      return value;
    }
  }

  return undefined;
}

/**
 * Extract a `Retry-After` header value from an error, if available.
 *
 * Checks for `headers` (object or `Headers` instance) and `response.headers`.
 */
function extractRetryAfterHeader(error: unknown): string | undefined {
  if (error == null || typeof error !== "object") {
    return undefined;
  }

  const record = error as Record<string, unknown>;

  // Direct headers property
  const headers = record["headers"];
  if (headers != null) {
    const value = getHeaderValue(headers, "retry-after");
    if (value != null) return value;
  }

  // Nested response.headers
  const response = record["response"];
  if (response != null && typeof response === "object") {
    const responseHeaders = (response as Record<string, unknown>)["headers"];
    if (responseHeaders != null) {
      const value = getHeaderValue(responseHeaders, "retry-after");
      if (value != null) return value;
    }
  }

  return undefined;
}

function getHeaderValue(headers: unknown, name: string): string | undefined {
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }

  if (typeof headers === "object" && headers !== null) {
    const record = headers as Record<string, unknown>;
    // Case-insensitive lookup
    for (const key of Object.keys(record)) {
      if (key.toLowerCase() === name) {
        const val = record[key];
        return typeof val === "string" ? val : undefined;
      }
    }
  }

  return undefined;
}

/**
 * Classify an error as retryable or non-retryable.
 *
 * Classification priority:
 * 1. Non-retryable status codes (400, 401, 403, etc.) → not retryable
 * 2. Retryable status codes (429, 500, 502, 503, 504) → retryable
 * 3. Network/transient error patterns → retryable
 * 4. Unknown errors → not retryable (safe default)
 */
export function classifyError(
  error: unknown,
  now: () => number = Date.now,
): RetryClassification {
  const statusCode = extractStatusCode(error);
  const retryAfterRaw = extractRetryAfterHeader(error);
  const retryAfterMs = parseRetryAfter(retryAfterRaw, now);

  // Check non-retryable status codes first
  if (statusCode !== undefined && NON_RETRYABLE_STATUS_CODES.has(statusCode)) {
    return {
      retryable: false,
      reason: `HTTP ${statusCode} is not retryable`,
    };
  }

  // Check retryable status codes
  if (statusCode !== undefined && RETRYABLE_STATUS_CODES.has(statusCode)) {
    return {
      retryable: true,
      retryAfterMs,
      reason: `HTTP ${statusCode} is retryable`,
    };
  }

  // Check for network/transient error patterns in message
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  for (const pattern of TRANSIENT_ERROR_PATTERNS) {
    if (message.includes(pattern)) {
      return {
        retryable: true,
        retryAfterMs,
        reason: `Transient network error: ${pattern}`,
      };
    }
  }

  // Safe default: unknown errors are not retryable
  return {
    retryable: false,
    reason: "Unknown error type — not retryable by default",
  };
}

// ---------------------------------------------------------------------------
// Backoff policy
// ---------------------------------------------------------------------------

export interface BackoffOptions {
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: boolean;
  randomFn?: () => number;
}

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;

/**
 * Calculate the backoff delay for a given attempt using exponential backoff
 * with optional jitter.
 *
 * Formula: `min(baseDelay * 2^attempt, maxDelay) + jitter(0–25%)`
 *
 * @param attempt - Zero-based attempt index (0 = first retry)
 * @param options - Backoff configuration
 * @returns Delay in milliseconds
 */
export function calculateBackoff(attempt: number, options: BackoffOptions = {}): number {
  const {
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    jitter = true,
    randomFn = Math.random,
  } = options;

  const exponentialDelay = baseDelayMs * Math.pow(2, attempt);
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  if (!jitter) {
    return cappedDelay;
  }

  // Add 0–25% jitter to prevent thundering herd
  const jitterAmount = cappedDelay * 0.25 * randomFn();
  return Math.ceil(cappedDelay + jitterAmount);
}

// ---------------------------------------------------------------------------
// Retry executor
// ---------------------------------------------------------------------------

export interface RetryOptions {
  /** Maximum number of attempts (including the initial call). Default: 3 */
  maxAttempts?: number;
  /** Maximum cumulative wall-clock duration in ms. Default: 60_000 */
  maxDurationMs?: number;
  /** Base delay for exponential backoff in ms. Default: 1_000 */
  baseDelayMs?: number;
  /** Maximum single-retry delay in ms. Default: 30_000 */
  maxDelayMs?: number;
  /** Abort signal for external cancellation. */
  signal?: AbortSignal;
  /** Callback invoked before each retry wait. */
  onRetry?: (attempt: number, delay: number, error: Error) => void;
  /** Enable jitter on backoff delays. Default: true */
  jitter?: boolean;
  /** Injectable random function for deterministic testing. */
  randomFn?: () => number;
  /** Injectable clock for deterministic testing. */
  now?: () => number;
  /** Injectable sleep function for testing. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Default sleep implementation using `Bun.sleep` when available, falling back
 * to a promise-based `setTimeout` wrapper.
 */
async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);

    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
      };

      if (signal.aborted) {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
        return;
      }

      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

/**
 * Wrap an error to ensure it is an `Error` instance.
 */
function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new ProviderError(String(value));
}

/**
 * Execute an async operation with automatic retry for transient failures.
 *
 * - Classifies each failure as retryable or non-retryable
 * - Non-retryable errors are thrown immediately
 * - Retryable errors trigger exponential backoff with optional jitter
 * - Respects `Retry-After` headers when present
 * - Enforces both max-attempt and max-duration caps
 * - Supports external cancellation via `AbortSignal`
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    maxDurationMs = 60_000,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    signal,
    onRetry,
    jitter = true,
    randomFn,
    now = Date.now,
    sleepFn = defaultSleep,
  } = options;

  const startTime = now();
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check abort before each attempt
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    }

    // Check cumulative duration cap (skip on first attempt)
    if (attempt > 0) {
      const elapsed = now() - startTime;
      if (elapsed >= maxDurationMs) {
        throw new RetryExhaustedError(
          `Retry duration limit exceeded (${elapsed}ms >= ${maxDurationMs}ms)`,
          lastError,
          attempt,
        );
      }
    }

    try {
      return await fn();
    } catch (thrown: unknown) {
      lastError = toError(thrown);

      // Classify the error
      const classification = classifyError(thrown, now);

      // Non-retryable: throw immediately
      if (!classification.retryable) {
        throw lastError;
      }

      // Last attempt: throw without waiting
      if (attempt + 1 >= maxAttempts) {
        throw new RetryExhaustedError(
          `Retry attempts exhausted (${attempt + 1}/${maxAttempts})`,
          lastError,
          attempt + 1,
        );
      }

      // Calculate delay: prefer Retry-After when available
      const calculatedDelay = calculateBackoff(attempt, {
        baseDelayMs,
        maxDelayMs,
        jitter,
        randomFn,
      });
      const delay = classification.retryAfterMs != null
        ? Math.max(classification.retryAfterMs, 0)
        : calculatedDelay;

      // Check if waiting would exceed duration cap
      const elapsed = now() - startTime;
      if (elapsed + delay >= maxDurationMs) {
        throw new RetryExhaustedError(
          `Retry would exceed duration limit (${elapsed + delay}ms >= ${maxDurationMs}ms)`,
          lastError,
          attempt + 1,
        );
      }

      // Notify callback
      if (onRetry) {
        onRetry(attempt + 1, delay, lastError);
      }

      // Wait before retrying
      await sleepFn(delay, signal);
    }
  }

  // Should be unreachable, but TypeScript needs this
  throw lastError ?? new ReinsError("Retry failed unexpectedly", "RETRY_ERROR");
}

// ---------------------------------------------------------------------------
// Retry-specific error
// ---------------------------------------------------------------------------

/**
 * Thrown when all retry attempts are exhausted or the cumulative duration cap
 * is exceeded.
 */
export class RetryExhaustedError extends ReinsError {
  constructor(
    message: string,
    public readonly lastError: Error | undefined,
    public readonly attempts: number,
  ) {
    super(message, "RETRY_EXHAUSTED", lastError);
    this.name = "RetryExhaustedError";
  }
}
