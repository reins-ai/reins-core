import { WebSearchError } from "../errors";

/**
 * Extracts rate-limit information from response headers.
 */
export function extractRateLimitInfo(response: Response): RateLimitInfo | null {
  const retryAfter = response.headers.get("retry-after");
  const remaining = response.headers.get("x-ratelimit-remaining");
  const limit = response.headers.get("x-ratelimit-limit");

  if (!retryAfter && !remaining) {
    return null;
  }

  return {
    retryAfterMs: parseRetryAfter(retryAfter),
    remaining: remaining ? parseInt(remaining, 10) : undefined,
    limit: limit ? parseInt(limit, 10) : undefined,
  };
}

export interface RateLimitInfo {
  retryAfterMs?: number;
  remaining?: number;
  limit?: number;
}

/**
 * Creates a WebSearchError for HTTP error responses with standard classification.
 */
export function createHttpError(
  providerName: string,
  status: number,
  rateLimitInfo?: RateLimitInfo | null,
): WebSearchError {
  if (status === 401) {
    return new WebSearchError(`${providerName} API key is invalid or missing`);
  }

  if (status === 403) {
    return new WebSearchError(
      `${providerName} API key does not have sufficient permissions`,
    );
  }

  if (status === 429) {
    const retryMsg = rateLimitInfo?.retryAfterMs
      ? ` Retry after ${Math.ceil(rateLimitInfo.retryAfterMs / 1000)} seconds.`
      : "";
    return new WebSearchError(
      `${providerName} API rate limit exceeded.${retryMsg}`,
    );
  }

  return new WebSearchError(`${providerName} API error (HTTP ${status})`);
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = parseInt(value, 10);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }

  const date = new Date(value);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    return delayMs > 0 ? delayMs : undefined;
  }

  return undefined;
}
