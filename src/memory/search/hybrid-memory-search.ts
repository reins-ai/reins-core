import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { MemoryLayer, MemoryType } from "../types/index";
import type { BM25Retriever, BM25SearchResult } from "./bm25-retriever";
import {
  ReciprocalRankFusionPolicy,
  WeightedSumPolicy,
  type FusionParams,
  type RankingPolicy,
} from "./ranking-policy";
import type { VectorRetriever, VectorSearchResult } from "./vector-retriever";

const DEFAULT_LIMIT = 10;
const DEFAULT_BM25_WEIGHT = 0.3;
const DEFAULT_VECTOR_WEIGHT = 0.7;
const DEFAULT_IMPORTANCE_BOOST = 0.1;
const CANDIDATE_MULTIPLIER = 3;

export interface HybridSearchOptions {
  limit?: number;
  bm25Weight?: number;
  vectorWeight?: number;
  importanceBoost?: number;
  memoryTypes?: MemoryType[];
  layers?: MemoryLayer[];
  minScore?: number;
}

export interface HybridSearchResult {
  memoryId: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  importance: number;
  score: number;
  breakdown: {
    bm25Score: number;
    vectorScore: number;
    importanceBoost: number;
    bm25Weight: number;
    vectorWeight: number;
  };
  source: {
    type: string;
    conversationId?: string;
  };
}

export interface HybridMemorySearchOptions {
  bm25Retriever: BM25Retriever;
  vectorRetriever: VectorRetriever;
  rankingPolicy?: RankingPolicy;
}

interface HybridCandidate {
  memoryId: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  importance: number;
  bm25Score: number;
  vectorScore: number;
  bm25Rank?: number;
  vectorRank?: number;
  sourceType?: string;
  conversationId?: string;
}

interface NormalizedWeights {
  bm25Weight: number;
  vectorWeight: number;
}

export class HybridMemorySearchError extends ReinsError {
  constructor(message: string, code = "HYBRID_MEMORY_SEARCH_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "HybridMemorySearchError";
  }
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

function clamp01(value: number): number {
  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

function normalizeWeights(bm25Weight: number, vectorWeight: number): NormalizedWeights {
  const safeBm25 = Math.max(0, bm25Weight);
  const safeVector = Math.max(0, vectorWeight);
  const total = safeBm25 + safeVector;

  if (total === 0) {
    return {
      bm25Weight: DEFAULT_BM25_WEIGHT,
      vectorWeight: DEFAULT_VECTOR_WEIGHT,
    };
  }

  return {
    bm25Weight: safeBm25 / total,
    vectorWeight: safeVector / total,
  };
}

function validateOptions(options: HybridSearchOptions | undefined): Result<void, HybridMemorySearchError> {
  if (!options) {
    return ok(undefined);
  }

  if (typeof options.limit !== "undefined" && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    return err(
      new HybridMemorySearchError(
        "Hybrid search option 'limit' must be a positive integer",
        "HYBRID_MEMORY_SEARCH_INVALID_OPTIONS",
      ),
    );
  }

  if (typeof options.bm25Weight !== "undefined" && (!Number.isFinite(options.bm25Weight) || options.bm25Weight < 0)) {
    return err(
      new HybridMemorySearchError(
        "Hybrid search option 'bm25Weight' must be a non-negative number",
        "HYBRID_MEMORY_SEARCH_INVALID_OPTIONS",
      ),
    );
  }

  if (
    typeof options.vectorWeight !== "undefined" &&
    (!Number.isFinite(options.vectorWeight) || options.vectorWeight < 0)
  ) {
    return err(
      new HybridMemorySearchError(
        "Hybrid search option 'vectorWeight' must be a non-negative number",
        "HYBRID_MEMORY_SEARCH_INVALID_OPTIONS",
      ),
    );
  }

  if (
    typeof options.importanceBoost !== "undefined" &&
    (!Number.isFinite(options.importanceBoost) || options.importanceBoost < 0)
  ) {
    return err(
      new HybridMemorySearchError(
        "Hybrid search option 'importanceBoost' must be a non-negative number",
        "HYBRID_MEMORY_SEARCH_INVALID_OPTIONS",
      ),
    );
  }

  if (typeof options.minScore !== "undefined" && (!Number.isFinite(options.minScore) || options.minScore < 0 || options.minScore > 1)) {
    return err(
      new HybridMemorySearchError(
        "Hybrid search option 'minScore' must be between 0 and 1",
        "HYBRID_MEMORY_SEARCH_INVALID_OPTIONS",
      ),
    );
  }

  return ok(undefined);
}

function applyBm25Candidate(
  candidates: Map<string, HybridCandidate>,
  result: BM25SearchResult,
  rank: number,
): void {
  const existing = candidates.get(result.memoryId);
  if (existing) {
    existing.bm25Score = result.bm25Score;
    existing.bm25Rank = rank;
    return;
  }

  const candidate: HybridCandidate = {
    memoryId: result.memoryId,
    content: result.content,
    type: result.type,
    layer: result.layer,
    importance: result.importance,
    bm25Score: result.bm25Score,
    vectorScore: 0,
    bm25Rank: rank,
    vectorRank: undefined,
  };

  candidates.set(result.memoryId, candidate);
}

function applyVectorCandidate(
  candidates: Map<string, HybridCandidate>,
  result: VectorSearchResult,
  rank: number,
): void {
  const existing = candidates.get(result.memoryId);
  if (existing) {
    existing.vectorScore = result.similarity;
    existing.vectorRank = rank;
    return;
  }

  const candidate: HybridCandidate = {
    memoryId: result.memoryId,
    content: result.content,
    type: result.type,
    layer: result.layer,
    importance: result.importance,
    bm25Score: 0,
    vectorScore: result.similarity,
    bm25Rank: undefined,
    vectorRank: rank,
  };

  candidates.set(result.memoryId, candidate);
}

function sortByScore(results: HybridSearchResult[]): HybridSearchResult[] {
  return results.sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    if (right.breakdown.vectorScore !== left.breakdown.vectorScore) {
      return right.breakdown.vectorScore - left.breakdown.vectorScore;
    }

    if (right.breakdown.bm25Score !== left.breakdown.bm25Score) {
      return right.breakdown.bm25Score - left.breakdown.bm25Score;
    }

    return left.memoryId.localeCompare(right.memoryId);
  });
}

function buildFusionParams(candidate: HybridCandidate, weights: NormalizedWeights, importanceBoost: number): FusionParams {
  return {
    bm25Score: clamp01(candidate.bm25Score),
    vectorScore: clamp01(candidate.vectorScore),
    importance: clamp01(candidate.importance),
    bm25Weight: weights.bm25Weight,
    vectorWeight: weights.vectorWeight,
    importanceBoost,
    bm25Rank: candidate.bm25Rank,
    vectorRank: candidate.vectorRank,
  };
}

function isRrfPolicy(policy: RankingPolicy): policy is ReciprocalRankFusionPolicy {
  return policy.name === "rrf";
}

export class HybridMemorySearch {
  private readonly bm25Retriever: BM25Retriever;
  private readonly vectorRetriever: VectorRetriever;
  private readonly rankingPolicy: RankingPolicy;

  constructor(options: HybridMemorySearchOptions) {
    this.bm25Retriever = options.bm25Retriever;
    this.vectorRetriever = options.vectorRetriever;
    this.rankingPolicy = options.rankingPolicy ?? new WeightedSumPolicy();
  }

  async search(
    query: string,
    options?: HybridSearchOptions,
  ): Promise<Result<HybridSearchResult[], HybridMemorySearchError>> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return ok([]);
    }

    const validation = validateOptions(options);
    if (!validation.ok) {
      return validation;
    }

    const limit = options?.limit ?? DEFAULT_LIMIT;
    const importanceBoost = options?.importanceBoost ?? DEFAULT_IMPORTANCE_BOOST;
    const weights = normalizeWeights(
      options?.bm25Weight ?? DEFAULT_BM25_WEIGHT,
      options?.vectorWeight ?? DEFAULT_VECTOR_WEIGHT,
    );
    const candidateLimit = Math.max(limit * CANDIDATE_MULTIPLIER, limit);

    const settled = await Promise.allSettled([
      Promise.resolve(
        this.bm25Retriever.search(trimmedQuery, {
          limit: candidateLimit,
          memoryTypes: options?.memoryTypes,
          layers: options?.layers,
        }),
      ),
      this.vectorRetriever.search(trimmedQuery, {
        limit: candidateLimit,
        memoryTypes: options?.memoryTypes,
        layers: options?.layers,
      }),
    ]);

    const bm25Settled = settled[0];
    const vectorSettled = settled[1];

    const bm25Failed =
      bm25Settled.status === "rejected" || (bm25Settled.status === "fulfilled" && !bm25Settled.value.ok);
    const vectorFailed =
      vectorSettled.status === "rejected" ||
      (vectorSettled.status === "fulfilled" && !vectorSettled.value.ok);

    if (bm25Failed && vectorFailed) {
      const bm25Error =
        bm25Settled.status === "rejected"
          ? asError(bm25Settled.reason)
          : bm25Settled.status === "fulfilled" && !bm25Settled.value.ok
            ? bm25Settled.value.error
            : undefined;

      const vectorError =
        vectorSettled.status === "rejected"
          ? asError(vectorSettled.reason)
          : vectorSettled.status === "fulfilled" && !vectorSettled.value.ok
            ? vectorSettled.value.error
            : undefined;

      return err(
        new HybridMemorySearchError(
          "Hybrid search failed: both BM25 and vector retrieval failed",
          "HYBRID_MEMORY_SEARCH_RETRIEVERS_FAILED",
          bm25Error ?? vectorError,
        ),
      );
    }

    const bm25Results =
      bm25Settled.status === "fulfilled" && bm25Settled.value.ok ? bm25Settled.value.value : [];
    const vectorResults =
      vectorSettled.status === "fulfilled" && vectorSettled.value.ok ? vectorSettled.value.value : [];

    if (bm25Results.length === 0 && vectorResults.length === 0) {
      return ok([]);
    }

    const candidates = new Map<string, HybridCandidate>();

    for (let index = 0; index < bm25Results.length; index += 1) {
      const result = bm25Results[index];
      applyBm25Candidate(candidates, result, index + 1);
    }

    for (let index = 0; index < vectorResults.length; index += 1) {
      const result = vectorResults[index];
      applyVectorCandidate(candidates, result, index + 1);
    }

    const results: HybridSearchResult[] = [];
    for (const candidate of candidates.values()) {
      const params = buildFusionParams(candidate, weights, importanceBoost);
      const score = clamp01(this.rankingPolicy.fuse(params));
      const importanceContribution = clamp01(candidate.importance) * importanceBoost;

      results.push({
        memoryId: candidate.memoryId,
        content: candidate.content,
        type: candidate.type,
        layer: candidate.layer,
        importance: candidate.importance,
        score,
        breakdown: {
          bm25Score: params.bm25Score,
          vectorScore: params.vectorScore,
          importanceBoost: importanceContribution,
          bm25Weight: isRrfPolicy(this.rankingPolicy) ? 0 : weights.bm25Weight,
          vectorWeight: isRrfPolicy(this.rankingPolicy) ? 0 : weights.vectorWeight,
        },
        source: {
          type: candidate.sourceType ?? "memory",
          conversationId: candidate.conversationId,
        },
      });
    }

    const minScore = options?.minScore;
    const filtered = typeof minScore === "number" ? results.filter((item) => item.score >= minScore) : results;
    const ranked = sortByScore(filtered);

    return ok(ranked.slice(0, limit));
  }
}
