import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import { ImportanceScorer } from "../consolidation/importance-scorer";
import type { MemoryRecord } from "../types/index";

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "for",
  "from",
  "i",
  "if",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "so",
  "that",
  "the",
  "to",
  "user",
  "we",
  "with",
  "you",
]);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_WEEK_MS = 7 * ONE_DAY_MS;

export type PatternType = "behavioral" | "preference" | "temporal" | "topical";

export interface PatternConfig {
  minOccurrences: number;
  windowMs: number;
  confidenceThreshold: number;
  decayRate: number;
  promotionThreshold: number;
}

export interface DetectedPattern {
  id: string;
  content: string;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
  confidence: number;
  sourceMemoryIds: string[];
  patternType: PatternType;
}

export interface PatternPromotion {
  patternId: string;
  promotedMemory: MemoryRecord;
  evidenceChain: string[];
  promotedAt: number;
}

export interface PatternMemoryLookup {
  listRecentMemories?(windowStart: Date, now: Date): ReadonlyArray<MemoryRecord>;
  expectedOccurrencesFor?(patternType: PatternType): number;
}

interface NormalizedMemory {
  memory: MemoryRecord;
  normalizedContent: string;
  contentTokens: string[];
  topicTokens: string[];
  createdAtMs: number;
}

interface PatternCluster {
  id: string;
  items: NormalizedMemory[];
}

const DEFAULT_PATTERN_CONFIG: PatternConfig = {
  minOccurrences: 3,
  windowMs: 30 * ONE_DAY_MS,
  confidenceThreshold: 0.5,
  decayRate: 0.15,
  promotionThreshold: 0.7,
};

export class PatternDetectorError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "MEMORY_PATTERN_DETECTOR_ERROR", cause);
    this.name = "PatternDetectorError";
  }
}

export class PatternDetector {
  private readonly lookup: PatternMemoryLookup;

  private readonly scorer: ImportanceScorer;

  private readonly config: PatternConfig;

  private readonly now: () => Date;

  private readonly generateId: () => string;

  constructor(options: {
    lookup: PatternMemoryLookup;
    scorer: ImportanceScorer;
    config?: Partial<PatternConfig>;
    now?: () => Date;
    generateId?: () => string;
  }) {
    this.lookup = options.lookup;
    this.scorer = options.scorer;
    this.config = {
      minOccurrences: options.config?.minOccurrences ?? DEFAULT_PATTERN_CONFIG.minOccurrences,
      windowMs: options.config?.windowMs ?? DEFAULT_PATTERN_CONFIG.windowMs,
      confidenceThreshold: options.config?.confidenceThreshold ?? DEFAULT_PATTERN_CONFIG.confidenceThreshold,
      decayRate: options.config?.decayRate ?? DEFAULT_PATTERN_CONFIG.decayRate,
      promotionThreshold: options.config?.promotionThreshold ?? DEFAULT_PATTERN_CONFIG.promotionThreshold,
    };
    this.now = options.now ?? (() => new Date());
    this.generateId = options.generateId ?? (() => `pattern-${Math.random().toString(36).slice(2, 10)}`);

    this.validateConfig();
  }

  detectPatterns(memoryHistory: MemoryRecord[]): Result<DetectedPattern[], PatternDetectorError> {
    try {
      const now = this.now();
      const windowStart = new Date(now.getTime() - this.config.windowMs);
      const withinWindow = this.collectWithinWindow(memoryHistory, windowStart, now);
      if (withinWindow.length === 0) {
        return ok([]);
      }

      const normalized = withinWindow
        .map((memory) => this.normalizeMemory(memory))
        .filter((item) => item.contentTokens.length > 0 || item.topicTokens.length > 0)
        .sort((left, right) => left.createdAtMs - right.createdAtMs);

      if (normalized.length === 0) {
        return ok([]);
      }

      const clusters = this.clusterMemories(normalized);
      const detected = clusters
        .map((cluster) => this.toPattern(cluster, now.getTime()))
        .filter((pattern): pattern is DetectedPattern => pattern !== undefined)
        .filter((pattern) => pattern.confidence >= this.config.confidenceThreshold)
        .sort((left, right) => {
          if (right.confidence !== left.confidence) {
            return right.confidence - left.confidence;
          }
          return right.occurrences - left.occurrences;
        });

      return ok(detected);
    } catch (error: unknown) {
      return err(
        new PatternDetectorError(
          "Failed to detect recurring memory patterns",
          error instanceof Error ? error : undefined,
        ),
      );
    }
  }

  promoteToPreference(pattern: DetectedPattern): PatternPromotion {
    const promotedAt = this.now();
    const reinforcementCount = Math.max(0, pattern.occurrences - this.config.minOccurrences);
    const importance = this.scorer.reinforce(pattern.confidence, reinforcementCount);

    const promotedMemory: MemoryRecord = {
      id: this.generateId(),
      content: this.toPreferenceContent(pattern),
      type: "preference",
      layer: "ltm",
      tags: ["pattern-detected", `pattern:${pattern.patternType}`],
      entities: [],
      importance,
      confidence: pattern.confidence,
      provenance: {
        sourceType: "implicit",
        conversationId: pattern.sourceMemoryIds.join(","),
      },
      createdAt: promotedAt,
      updatedAt: promotedAt,
      accessedAt: promotedAt,
    };

    return {
      patternId: pattern.id,
      promotedMemory,
      evidenceChain: [...pattern.sourceMemoryIds],
      promotedAt: promotedAt.getTime(),
    };
  }

  decayPatterns(patterns: DetectedPattern[], now: number): DetectedPattern[] {
    return patterns
      .map((pattern) => {
        const elapsedMs = Math.max(0, now - pattern.lastSeen);
        if (elapsedMs <= this.config.windowMs) {
          return pattern;
        }

        const windowsElapsed = elapsedMs / this.config.windowMs;
        const decayedConfidence = clampScore(pattern.confidence - windowsElapsed * this.config.decayRate);
        return {
          ...pattern,
          confidence: decayedConfidence,
        };
      })
      .filter((pattern) => pattern.confidence >= this.config.confidenceThreshold);
  }

  private validateConfig(): void {
    if (this.config.minOccurrences < 2) {
      throw new PatternDetectorError("minOccurrences must be >= 2");
    }
    if (this.config.windowMs <= 0) {
      throw new PatternDetectorError("windowMs must be > 0");
    }
    if (this.config.confidenceThreshold < 0 || this.config.confidenceThreshold > 1) {
      throw new PatternDetectorError("confidenceThreshold must be between 0 and 1");
    }
    if (this.config.decayRate < 0 || this.config.decayRate > 1) {
      throw new PatternDetectorError("decayRate must be between 0 and 1");
    }
    if (
      this.config.promotionThreshold < 0 ||
      this.config.promotionThreshold > 1 ||
      this.config.promotionThreshold < this.config.confidenceThreshold
    ) {
      throw new PatternDetectorError(
        "promotionThreshold must be between 0 and 1 and >= confidenceThreshold",
      );
    }
  }

  private collectWithinWindow(
    memoryHistory: MemoryRecord[],
    windowStart: Date,
    now: Date,
  ): MemoryRecord[] {
    const byId = new Map<string, MemoryRecord>();
    for (const memory of memoryHistory) {
      byId.set(memory.id, memory);
    }

    const lookedUp = this.lookup.listRecentMemories?.(windowStart, now) ?? [];
    for (const memory of lookedUp) {
      if (!byId.has(memory.id)) {
        byId.set(memory.id, memory);
      }
    }

    return [...byId.values()].filter(
      (memory) => memory.createdAt.getTime() >= windowStart.getTime() && memory.createdAt.getTime() <= now.getTime(),
    );
  }

  private normalizeMemory(memory: MemoryRecord): NormalizedMemory {
    const normalizedContent = normalizeText(memory.content);
    const contentTokens = tokenize(normalizedContent);
    const topicTokens = dedupeStrings([
      ...memory.tags.map((tag) => normalizeText(tag)),
      ...memory.entities.map((entity) => normalizeText(entity)),
      ...contentTokens.slice(0, 3),
    ]);

    return {
      memory,
      normalizedContent,
      contentTokens,
      topicTokens,
      createdAtMs: memory.createdAt.getTime(),
    };
  }

  private clusterMemories(memories: NormalizedMemory[]): PatternCluster[] {
    const clusters: PatternCluster[] = [];

    for (const candidate of memories) {
      let bestCluster: PatternCluster | undefined;
      let bestScore = 0;

      for (const cluster of clusters) {
        const score = this.clusterSimilarity(cluster, candidate);
        if (score > bestScore) {
          bestScore = score;
          bestCluster = cluster;
        }
      }

      if (bestCluster && bestScore >= 0.18) {
        bestCluster.items.push(candidate);
        continue;
      }

      clusters.push({
        id: this.generateId(),
        items: [candidate],
      });
    }

    return clusters;
  }

  private clusterSimilarity(cluster: PatternCluster, candidate: NormalizedMemory): number {
    const contentSimilarities = cluster.items.map((item) =>
      jaccardSimilarity(item.contentTokens, candidate.contentTokens),
    );
    const topicSimilarities = cluster.items.map((item) =>
      overlapRatio(item.topicTokens, candidate.topicTokens),
    );

    const contentScore = contentSimilarities.length === 0 ? 0 : Math.max(...contentSimilarities);
    const topicScore = topicSimilarities.length === 0 ? 0 : Math.max(...topicSimilarities);

    return contentScore * 0.7 + topicScore * 0.3;
  }

  private toPattern(cluster: PatternCluster, nowMs: number): DetectedPattern | undefined {
    if (cluster.items.length < this.config.minOccurrences) {
      return undefined;
    }

    const sortedByCreated = cluster.items
      .slice()
      .sort((left, right) => left.createdAtMs - right.createdAtMs);
    const firstSeen = sortedByCreated[0].createdAtMs;
    const lastSeen = sortedByCreated[sortedByCreated.length - 1].createdAtMs;
    const sourceMemoryIds = sortedByCreated.map((item) => item.memory.id);
    const patternType = inferPatternType(sortedByCreated);
    const confidence = this.calculateConfidence(sortedByCreated, patternType, nowMs, lastSeen);

    if (confidence < this.config.confidenceThreshold) {
      return undefined;
    }

    return {
      id: cluster.id,
      content: selectPatternDescription(sortedByCreated),
      occurrences: sortedByCreated.length,
      firstSeen,
      lastSeen,
      confidence,
      sourceMemoryIds,
      patternType,
    };
  }

  private calculateConfidence(
    records: NormalizedMemory[],
    patternType: PatternType,
    nowMs: number,
    lastSeenMs: number,
  ): number {
    const expectedOccurrences =
      this.lookup.expectedOccurrencesFor?.(patternType) ??
      Math.max(this.config.minOccurrences, Math.ceil(this.config.windowMs / ONE_WEEK_MS));

    const frequencyFactor = clampScore(records.length / Math.max(1, expectedOccurrences));
    const recencyRatio = Math.min(1, Math.max(0, (nowMs - lastSeenMs) / this.config.windowMs));
    const recencyFactor = clampScore(1 - recencyRatio * this.config.decayRate);
    const consistencyFactor = this.calculateConsistencyFactor(records);

    return clampScore(frequencyFactor * recencyFactor * consistencyFactor);
  }

  private calculateConsistencyFactor(records: NormalizedMemory[]): number {
    if (records.length <= 1) {
      return 1;
    }

    let comparisons = 0;
    let contentScoreTotal = 0;
    let topicScoreTotal = 0;

    for (let leftIndex = 0; leftIndex < records.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < records.length; rightIndex += 1) {
        const left = records[leftIndex];
        const right = records[rightIndex];
        comparisons += 1;
        contentScoreTotal += jaccardSimilarity(left.contentTokens, right.contentTokens);
        topicScoreTotal += overlapRatio(left.topicTokens, right.topicTokens);
      }
    }

    if (comparisons === 0) {
      return 1;
    }

    const contentConsistency = contentScoreTotal / comparisons;
    const topicConsistency = topicScoreTotal / comparisons;
    const blendedConsistency = contentConsistency * 0.65 + topicConsistency * 0.35;
    return Math.max(0.5, clampScore(blendedConsistency));
  }

  private toPreferenceContent(pattern: DetectedPattern): string {
    const normalized = normalizeText(pattern.content);
    const trimmed = normalized.trim();
    if (trimmed.startsWith("prefers") || trimmed.startsWith("likes") || trimmed.startsWith("wants")) {
      return `user ${trimmed}`;
    }
    if (trimmed.startsWith("user ")) {
      return trimmed;
    }
    return `user prefers ${trimmed}`;
  }
}

function inferPatternType(items: NormalizedMemory[]): PatternType {
  const preferenceCount = items.filter((item) => item.memory.type === "preference").length;
  const temporalCount = items.filter((item) => hasTemporalSignal(item)).length;
  const topicalCount = items.filter((item) => item.topicTokens.length >= 2).length;

  if (preferenceCount / items.length >= 0.5) {
    return "preference";
  }
  if (temporalCount / items.length >= 0.5) {
    return "temporal";
  }
  if (topicalCount / items.length >= 0.75) {
    return "topical";
  }
  return "behavioral";
}

function hasTemporalSignal(item: NormalizedMemory): boolean {
  const temporalTokens = new Set([
    "daily",
    "every",
    "morning",
    "weekly",
    "month",
    "monthly",
    "nightly",
    "friday",
  ]);

  for (const token of [...item.contentTokens, ...item.topicTokens]) {
    if (temporalTokens.has(token)) {
      return true;
    }
  }
  return false;
}

function selectPatternDescription(items: NormalizedMemory[]): string {
  const byContent = new Map<string, number>();
  for (const item of items) {
    byContent.set(item.normalizedContent, (byContent.get(item.normalizedContent) ?? 0) + 1);
  }

  let best = "";
  let bestCount = -1;
  for (const [content, count] of byContent.entries()) {
    if (count > bestCount) {
      bestCount = count;
      best = content;
    }
  }

  if (best.length > 0) {
    return best;
  }
  return items[0]?.memory.content.trim().toLowerCase() ?? "";
}

function normalizeText(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(normalized: string): string[] {
  if (normalized.length === 0) {
    return [];
  }

  return normalized
    .split(" ")
    .filter((token) => token.length > 1)
    .filter((token) => !STOPWORDS.has(token));
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function jaccardSimilarity(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  const union = leftSet.size + rightSet.size - intersection;
  if (union === 0) {
    return 0;
  }
  return intersection / union;
}

function overlapRatio(left: string[], right: string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let overlap = 0;
  for (const token of leftSet) {
    if (rightSet.has(token)) {
      overlap += 1;
    }
  }
  return overlap / Math.min(leftSet.size, rightSet.size);
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}
