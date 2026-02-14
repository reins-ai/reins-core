import type { TextSearchResult, NewsSearchResult } from "../types";

function getString(obj: unknown, ...keys: string[]): string | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : undefined;
}

function getNumber(obj: unknown, ...keys: string[]): number | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" ? current : undefined;
}

function getArray(obj: unknown, ...keys: string[]): unknown[] {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return [];
    }
    current = (current as Record<string, unknown>)[key];
  }
  return Array.isArray(current) ? current : [];
}

function getFirstHighlight(obj: unknown): string | undefined {
  const highlights = getArray(obj, "highlights");
  if (highlights.length === 0) {
    return undefined;
  }
  const first = highlights[0];
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "unknown";
  }
}

/**
 * Maps Exa search API response into normalized text results.
 *
 * Exa shape: `{ results: [{ title, url, score, publishedDate, author, text, highlights }] }`
 */
export function mapExaTextResults(data: Record<string, unknown>): TextSearchResult[] {
  const results = getArray(data, "results");
  return results.map((item): TextSearchResult => ({
    type: "text",
    title: getString(item, "title") ?? "",
    url: getString(item, "url") ?? "",
    snippet: getFirstHighlight(item) ?? getString(item, "text")?.slice(0, 200),
    score: getNumber(item, "score"),
    publishedAt: getString(item, "publishedDate"),
    content: getString(item, "text"),
    author: getString(item, "author"),
  }));
}

/**
 * Maps Exa search API response (with news category) into normalized news results.
 *
 * Exa shape: same as text, but requested with `category: "news"`.
 * Source is extracted from the result URL hostname.
 */
export function mapExaNewsResults(data: Record<string, unknown>): NewsSearchResult[] {
  const results = getArray(data, "results");
  return results.map((item): NewsSearchResult => ({
    type: "news",
    title: getString(item, "title") ?? "",
    url: getString(item, "url") ?? "",
    snippet: getFirstHighlight(item) ?? getString(item, "text")?.slice(0, 200),
    score: getNumber(item, "score"),
    publishedAt: getString(item, "publishedDate"),
    source: extractDomain(getString(item, "url") ?? ""),
  }));
}
