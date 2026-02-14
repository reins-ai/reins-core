import type {
  TextSearchResult,
  ImageSearchResult,
  VideoSearchResult,
  NewsSearchResult,
} from "../types";

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

/**
 * Maps Brave web search API response into normalized text results.
 *
 * Brave shape: `{ web: { results: [{ title, url, description, page_age }] } }`
 */
export function mapBraveTextResults(data: Record<string, unknown>): TextSearchResult[] {
  const webResults = getArray(data, "web", "results");
  return webResults.map((item): TextSearchResult => ({
    type: "text",
    title: getString(item, "title") ?? "",
    url: getString(item, "url") ?? "",
    snippet: getString(item, "description"),
    publishedAt: getString(item, "page_age"),
  }));
}

/**
 * Maps Brave image search API response into normalized image results.
 *
 * Brave shape: `{ results: [{ title, url, thumbnail: { src, width, height }, source, properties: { url } }] }`
 */
export function mapBraveImageResults(data: Record<string, unknown>): ImageSearchResult[] {
  const imageResults = getArray(data, "results");
  return imageResults.map((item): ImageSearchResult => ({
    type: "image",
    title: getString(item, "title") ?? "",
    url: getString(item, "properties", "url") ?? getString(item, "url") ?? "",
    imageUrl: getString(item, "properties", "url") ?? getString(item, "url") ?? "",
    thumbnailUrl: getString(item, "thumbnail", "src"),
    width: getNumber(item, "thumbnail", "width"),
    height: getNumber(item, "thumbnail", "height"),
    source: getString(item, "source"),
  }));
}

/**
 * Maps Brave video search API response into normalized video results.
 *
 * Brave shape: `{ results: [{ title, url, thumbnail: { src }, description, video: { duration, views, publisher }, meta_url: { hostname } }] }`
 */
export function mapBraveVideoResults(data: Record<string, unknown>): VideoSearchResult[] {
  const videoResults = getArray(data, "results");
  return videoResults.map((item): VideoSearchResult => ({
    type: "video",
    title: getString(item, "title") ?? "",
    url: getString(item, "url") ?? "",
    snippet: getString(item, "description"),
    thumbnailUrl: getString(item, "thumbnail", "src"),
    duration: getString(item, "video", "duration"),
    source: getString(item, "meta_url", "hostname") ?? getString(item, "video", "publisher"),
    viewCount: getNumber(item, "video", "views"),
  }));
}

/**
 * Maps Brave news search API response into normalized news results.
 *
 * Brave shape: `{ results: [{ title, url, description, age, meta_url: { hostname }, thumbnail: { src } }] }`
 */
export function mapBraveNewsResults(data: Record<string, unknown>): NewsSearchResult[] {
  const newsResults = getArray(data, "results");
  return newsResults.map((item): NewsSearchResult => ({
    type: "news",
    title: getString(item, "title") ?? "",
    url: getString(item, "url") ?? "",
    snippet: getString(item, "description"),
    publishedAt: getString(item, "age"),
    source: getString(item, "meta_url", "hostname") ?? "",
    imageUrl: getString(item, "thumbnail", "src"),
  }));
}
