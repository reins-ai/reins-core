import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "./types";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function isExpired(entry: MemoryEntry, nowMs: number): boolean {
  return typeof entry.expiresAt !== "undefined" && entry.expiresAt.getTime() <= nowMs;
}

function getTextScore(content: string, query: string): number {
  const normalizedContent = content.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  const index = normalizedContent.indexOf(normalizedQuery);

  if (index === -1) {
    return -1;
  }

  if (normalizedContent === normalizedQuery) {
    return 1;
  }

  const positionScore = clamp01(1 - index / Math.max(1, normalizedContent.length));
  const lengthPenalty = clamp01(normalizedQuery.length / Math.max(1, normalizedContent.length));
  return clamp01(positionScore * 0.8 + lengthPenalty * 0.2);
}

function getRecencyScore(entry: MemoryEntry, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - entry.updatedAt.getTime());
  return 1 / (1 + ageMs / ONE_DAY_MS);
}

function hasAnyTag(entry: MemoryEntry, tags: string[]): boolean {
  if (tags.length === 0) {
    return true;
  }

  const requested = new Set(tags.map((tag) => tag.toLowerCase().trim()).filter(Boolean));
  if (requested.size === 0) {
    return true;
  }

  return entry.tags.some((tag) => requested.has(tag.toLowerCase()));
}

export function searchMemories(
  entries: MemoryEntry[],
  options: MemorySearchOptions,
): MemorySearchResult[] {
  const nowMs = Date.now();
  const query = options.query?.trim() ?? "";
  const hasQuery = query.length > 0;
  const minImportance = options.minImportance;
  const includeExpired = options.includeExpired ?? false;

  const ranked: MemorySearchResult[] = [];

  for (const entry of entries) {
    if (!includeExpired && isExpired(entry, nowMs)) {
      continue;
    }

    if (options.type && entry.type !== options.type) {
      continue;
    }

    if (!hasAnyTag(entry, options.tags ?? [])) {
      continue;
    }

    if (typeof minImportance === "number" && entry.importance < minImportance) {
      continue;
    }

    const textScore = hasQuery ? getTextScore(entry.content, query) : 0;
    if (hasQuery && textScore < 0) {
      continue;
    }

    const recencyScore = getRecencyScore(entry, nowMs);
    const importanceScore = clamp01(entry.importance);
    const score = hasQuery
      ? clamp01(textScore * 0.6 + importanceScore * 0.25 + recencyScore * 0.15)
      : clamp01(importanceScore * 0.7 + recencyScore * 0.3);

    ranked.push({ entry, score });
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    return right.entry.updatedAt.getTime() - left.entry.updatedAt.getTime();
  });

  if (typeof options.limit === "number") {
    return ranked.slice(0, Math.max(0, options.limit));
  }

  return ranked;
}
