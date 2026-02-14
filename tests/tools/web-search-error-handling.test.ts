import { describe, expect, it } from "bun:test";

import { BraveAdapter } from "../../src/tools/web-search/providers/brave-adapter";
import { ExaAdapter } from "../../src/tools/web-search/providers/exa-adapter";
import { WebSearchError } from "../../src/tools/web-search/errors";
import {
  mapSearchErrorToToolError,
  createUnsupportedTypeError,
  createMissingKeyError,
} from "../../src/tools/web-search/error-mapper";
import {
  extractRateLimitInfo,
  createHttpError,
} from "../../src/tools/web-search/providers/shared-http";
import {
  BRAVE_CAPABILITIES,
  EXA_CAPABILITIES,
} from "../../src/tools/web-search/provider-contract";
import { WEB_SEARCH_ERROR_CODES } from "../../src/tools/web-search/tool-contract";
import type { WebSearchQuery } from "../../src/tools/web-search/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchStatus(status: number, headers?: Record<string, string>): typeof fetch {
  return async () =>
    new Response(JSON.stringify({ error: "test error" }), {
      status,
      headers: {
        "Content-Type": "application/json",
        ...headers,
      },
    });
}

function mockFetchThrow(errorMessage: string): typeof fetch {
  return async () => {
    throw new Error(errorMessage);
  };
}

const textQuery: WebSearchQuery = { query: "test", searchType: "text" };

// ---------------------------------------------------------------------------
// BraveAdapter — error handling
// ---------------------------------------------------------------------------

describe("BraveAdapter errors", () => {
  it("returns auth error for 401 response", async () => {
    const adapter = new BraveAdapter({
      apiKey: "bad-key",
      fetchFn: mockFetchStatus(401),
    });

    const result = await adapter.search(textQuery);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("invalid or missing");
  });

  it("returns rate limit error for 429 response", async () => {
    const adapter = new BraveAdapter({
      apiKey: "test-key",
      fetchFn: mockFetchStatus(429),
    });

    const result = await adapter.search(textQuery);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("rate limit exceeded");
  });

  it("returns provider error for 500 response", async () => {
    const adapter = new BraveAdapter({
      apiKey: "test-key",
      fetchFn: mockFetchStatus(500),
    });

    const result = await adapter.search(textQuery);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("HTTP 500");
  });

  it("wraps network errors in WebSearchError", async () => {
    const adapter = new BraveAdapter({
      apiKey: "test-key",
      fetchFn: mockFetchThrow("fetch failed: ECONNREFUSED"),
    });

    const result = await adapter.search(textQuery);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// ExaAdapter — error handling
// ---------------------------------------------------------------------------

describe("ExaAdapter errors", () => {
  it("returns auth error for 401 response", async () => {
    const adapter = new ExaAdapter({
      apiKey: "bad-key",
      fetchFn: mockFetchStatus(401),
    });

    const result = await adapter.search(textQuery);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("invalid or missing");
  });

  it("returns rate limit error for 429 response", async () => {
    const adapter = new ExaAdapter({
      apiKey: "test-key",
      fetchFn: mockFetchStatus(429),
    });

    const result = await adapter.search(textQuery);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("rate limit exceeded");
  });

  it("returns provider error for 500 response", async () => {
    const adapter = new ExaAdapter({
      apiKey: "test-key",
      fetchFn: mockFetchStatus(500),
    });

    const result = await adapter.search(textQuery);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("HTTP 500");
  });

  it("wraps network errors in WebSearchError", async () => {
    const adapter = new ExaAdapter({
      apiKey: "test-key",
      fetchFn: mockFetchThrow("network error: ENOTFOUND"),
    });

    const result = await adapter.search(textQuery);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("ENOTFOUND");
  });

  it("returns error for unsupported image search type", async () => {
    const adapter = new ExaAdapter({
      apiKey: "test-key",
      fetchFn: mockFetchStatus(200),
    });

    const result = await adapter.search({ query: "cats", searchType: "image" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("does not support search type: image");
  });

  it("returns error for unsupported video search type", async () => {
    const adapter = new ExaAdapter({
      apiKey: "test-key",
      fetchFn: mockFetchStatus(200),
    });

    const result = await adapter.search({ query: "tutorials", searchType: "video" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(WebSearchError);
    expect(result.error.message).toContain("does not support search type: video");
  });
});

// ---------------------------------------------------------------------------
// mapSearchErrorToToolError — error classification
// ---------------------------------------------------------------------------

describe("mapSearchErrorToToolError", () => {
  it("classifies rate limit errors", () => {
    const error = new WebSearchError("Brave API rate limit exceeded");
    const detail = mapSearchErrorToToolError(error, "brave");

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.RATE_LIMITED);
    expect(detail.retryable).toBe(true);
    expect(detail.details?.provider).toBe("brave");
  });

  it("classifies auth errors with 'invalid' keyword", () => {
    const error = new WebSearchError("API key is invalid or missing");
    const detail = mapSearchErrorToToolError(error, "exa");

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.AUTH_FAILED);
    expect(detail.retryable).toBe(false);
    expect(detail.details?.provider).toBe("exa");
  });

  it("classifies auth errors with 'api key' keyword", () => {
    const error = new WebSearchError("Exa API key not found");
    const detail = mapSearchErrorToToolError(error);

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.AUTH_FAILED);
    expect(detail.retryable).toBe(false);
  });

  it("classifies unsupported type errors", () => {
    const error = new WebSearchError("Exa does not support search type: image");
    const detail = mapSearchErrorToToolError(error, "exa");

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.UNSUPPORTED_TYPE);
    expect(detail.retryable).toBe(false);
  });

  it("classifies network errors", () => {
    const error = new WebSearchError("fetch failed: ECONNREFUSED");
    const detail = mapSearchErrorToToolError(error);

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.NETWORK_ERROR);
    expect(detail.retryable).toBe(true);
  });

  it("classifies ENOTFOUND as network error", () => {
    const error = new WebSearchError("DNS lookup failed: ENOTFOUND");
    const detail = mapSearchErrorToToolError(error);

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.NETWORK_ERROR);
    expect(detail.retryable).toBe(true);
  });

  it("classifies unknown errors as provider error", () => {
    const error = new WebSearchError("Something unexpected happened");
    const detail = mapSearchErrorToToolError(error);

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.PROVIDER_ERROR);
    expect(detail.retryable).toBe(true);
  });

  it("includes retryAfterMs for rate limit errors", () => {
    const error = new WebSearchError("rate limit exceeded");
    const detail = mapSearchErrorToToolError(error);

    expect(detail.details?.retryAfterMs).toBe(1000);
  });

  it("omits provider from details when not provided", () => {
    const error = new WebSearchError("Something failed");
    const detail = mapSearchErrorToToolError(error);

    expect(detail.details?.provider).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createUnsupportedTypeError
// ---------------------------------------------------------------------------

describe("createUnsupportedTypeError", () => {
  it("returns correct detail for Exa image search", () => {
    const detail = createUnsupportedTypeError("exa", "image", EXA_CAPABILITIES);

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.UNSUPPORTED_TYPE);
    expect(detail.retryable).toBe(false);
    expect(detail.message).toContain("image");
    expect(detail.message).toContain("exa");
    expect(detail.details?.supportedTypes).toEqual(["text", "news"]);
    expect(detail.details?.requestedType).toBe("image");
    expect(detail.details?.provider).toBe("exa");
  });

  it("returns correct detail for Exa video search", () => {
    const detail = createUnsupportedTypeError("exa", "video", EXA_CAPABILITIES);

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.UNSUPPORTED_TYPE);
    expect(detail.message).toContain("video");
    expect(detail.details?.supportedTypes).toEqual(["text", "news"]);
  });

  it("lists all supported types for Brave", () => {
    const detail = createUnsupportedTypeError("brave", "text", BRAVE_CAPABILITIES);

    expect(detail.details?.supportedTypes).toEqual(["text", "image", "video", "news"]);
  });
});

// ---------------------------------------------------------------------------
// createMissingKeyError
// ---------------------------------------------------------------------------

describe("createMissingKeyError", () => {
  it("returns auth failed error for brave", () => {
    const detail = createMissingKeyError("brave");

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.AUTH_FAILED);
    expect(detail.retryable).toBe(false);
    expect(detail.message).toContain("brave");
    expect(detail.message).toContain("API key");
    expect(detail.details?.provider).toBe("brave");
  });

  it("returns auth failed error for exa", () => {
    const detail = createMissingKeyError("exa");

    expect(detail.code).toBe(WEB_SEARCH_ERROR_CODES.AUTH_FAILED);
    expect(detail.retryable).toBe(false);
    expect(detail.message).toContain("exa");
    expect(detail.details?.provider).toBe("exa");
  });
});

// ---------------------------------------------------------------------------
// SharedHTTP — extractRateLimitInfo
// ---------------------------------------------------------------------------

describe("extractRateLimitInfo", () => {
  it("returns null when no rate limit headers present", () => {
    const response = new Response("", { headers: {} });
    const info = extractRateLimitInfo(response);

    expect(info).toBeNull();
  });

  it("parses retry-after header in seconds", () => {
    const response = new Response("", {
      headers: { "retry-after": "30" },
    });
    const info = extractRateLimitInfo(response);

    expect(info).not.toBeNull();
    expect(info!.retryAfterMs).toBe(30000);
  });

  it("parses x-ratelimit-remaining and x-ratelimit-limit headers", () => {
    const response = new Response("", {
      headers: {
        "x-ratelimit-remaining": "5",
        "x-ratelimit-limit": "100",
      },
    });
    const info = extractRateLimitInfo(response);

    expect(info).not.toBeNull();
    expect(info!.remaining).toBe(5);
    expect(info!.limit).toBe(100);
  });

  it("handles retry-after with only remaining header", () => {
    const response = new Response("", {
      headers: { "x-ratelimit-remaining": "0" },
    });
    const info = extractRateLimitInfo(response);

    expect(info).not.toBeNull();
    expect(info!.remaining).toBe(0);
    expect(info!.retryAfterMs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SharedHTTP — createHttpError
// ---------------------------------------------------------------------------

describe("createHttpError", () => {
  it("returns auth error for 401 status", () => {
    const error = createHttpError("Brave", 401);

    expect(error).toBeInstanceOf(WebSearchError);
    expect(error.message).toContain("invalid or missing");
    expect(error.message).toContain("Brave");
  });

  it("returns permission error for 403 status", () => {
    const error = createHttpError("Exa", 403);

    expect(error).toBeInstanceOf(WebSearchError);
    expect(error.message).toContain("sufficient permissions");
    expect(error.message).toContain("Exa");
  });

  it("returns rate limit error for 429 status", () => {
    const error = createHttpError("Brave", 429);

    expect(error).toBeInstanceOf(WebSearchError);
    expect(error.message).toContain("rate limit exceeded");
  });

  it("includes retry-after info in 429 message when available", () => {
    const error = createHttpError("Brave", 429, { retryAfterMs: 5000 });

    expect(error.message).toContain("Retry after 5 seconds");
  });

  it("returns generic HTTP error for other status codes", () => {
    const error = createHttpError("Brave", 502);

    expect(error).toBeInstanceOf(WebSearchError);
    expect(error.message).toContain("HTTP 502");
  });

  it("handles null rateLimitInfo gracefully for 429", () => {
    const error = createHttpError("Exa", 429, null);

    expect(error).toBeInstanceOf(WebSearchError);
    expect(error.message).toContain("rate limit exceeded");
    expect(error.message).not.toContain("Retry after");
  });
});
