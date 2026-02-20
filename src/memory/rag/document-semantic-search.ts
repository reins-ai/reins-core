import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { EmbeddingProvider } from "../embeddings/embedding-provider";
import type { DocumentSearchProvider, DocumentSearchResult } from "../search/unified-memory-retrieval";
import { cosineSimilarity } from "../search/vector-distance";

import type { IndexedChunk } from "./document-indexer";

const DEFAULT_TOP_K = 10;
const SEMANTIC_WEIGHT = 0.7;
const KEYWORD_WEIGHT = 0.3;

export interface DocumentSearchOptions {
  topK?: number;
  minScore?: number;
  sourceFilter?: string;
}

export interface RankedChunk {
  chunk: IndexedChunk;
  score: number;
  semanticScore: number;
  keywordScore: number;
  source: {
    path: string;
    heading: string | null;
  };
}

function normalizeTopK(topK: number | undefined): number {
  if (!Number.isFinite(topK)) {
    return DEFAULT_TOP_K;
  }

  const value = Math.trunc(topK ?? DEFAULT_TOP_K);
  if (value <= 0) {
    return 0;
  }

  return value;
}

function isSourceMatch(chunk: IndexedChunk, sourceFilter: string | undefined): boolean {
  if (!sourceFilter) {
    return true;
  }

  return chunk.sourcePath === sourceFilter || chunk.sourcePath.startsWith(`${sourceFilter}/`);
}

function tokenizeQuery(query: string): string[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return [];
  }

  return normalized.match(/\p{L}[\p{L}\p{N}_-]*/gu) ?? [];
}

function countKeywordMatches(content: string, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }

  const tokens = content.toLowerCase().match(/\p{L}[\p{L}\p{N}_-]*/gu) ?? [];
  if (tokens.length === 0) {
    return 0;
  }

  const tokenCounts = new Map<string, number>();
  for (const token of tokens) {
    tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  }

  let score = 0;
  for (const term of terms) {
    score += tokenCounts.get(term) ?? 0;
  }

  return score;
}

function buildKeywordScores(query: string, chunks: IndexedChunk[]): Map<string, number> {
  const terms = tokenizeQuery(query);
  const rawScores = new Map<string, number>();

  let maxScore = 0;
  for (const chunk of chunks) {
    const score = countKeywordMatches(chunk.content, terms);
    rawScores.set(chunk.id, score);
    if (score > maxScore) {
      maxScore = score;
    }
  }

  const normalizedScores = new Map<string, number>();
  if (maxScore === 0) {
    for (const chunk of chunks) {
      normalizedScores.set(chunk.id, 0);
    }
    return normalizedScores;
  }

  for (const chunk of chunks) {
    const score = rawScores.get(chunk.id) ?? 0;
    normalizedScores.set(chunk.id, score / maxScore);
  }

  return normalizedScores;
}

export interface HybridDocumentSearchOptions {
  embeddingProvider: EmbeddingProvider;
  semanticSearch?: DocumentSemanticSearch;
  getChunks?: (filters?: { sourceIds?: string[] }) => IndexedChunk[] | Promise<IndexedChunk[]>;
}

export class HybridDocumentSearchError extends ReinsError {
  constructor(message: string, code = "HYBRID_DOCUMENT_SEARCH_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "HybridDocumentSearchError";
  }
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

export class DocumentSemanticSearch {
  search(
    queryEmbedding: Float32Array,
    chunks: IndexedChunk[],
    options?: DocumentSearchOptions,
  ): RankedChunk[] {
    if (chunks.length === 0) {
      return [];
    }

    const topK = normalizeTopK(options?.topK);
    if (topK === 0) {
      return [];
    }

    const minScore = options?.minScore;
    const ranked: RankedChunk[] = [];

    for (const chunk of chunks) {
      if (!isSourceMatch(chunk, options?.sourceFilter)) {
        continue;
      }

      if (!(chunk.embedding instanceof Float32Array)) {
        continue;
      }

      let semanticScore: number;
      try {
        semanticScore = cosineSimilarity(queryEmbedding, chunk.embedding);
      } catch {
        continue;
      }

      if (typeof minScore === "number" && semanticScore < minScore) {
        continue;
      }

      ranked.push({
        chunk,
        score: semanticScore,
        semanticScore,
        keywordScore: 0,
        source: {
          path: chunk.sourcePath,
          heading: chunk.heading,
        },
      });
    }

    ranked.sort((left, right) => {
      if (right.semanticScore !== left.semanticScore) {
        return right.semanticScore - left.semanticScore;
      }

      return left.chunk.id.localeCompare(right.chunk.id);
    });

    return ranked.slice(0, topK);
  }
}

export class HybridDocumentSearch implements DocumentSearchProvider {
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly semanticSearch: DocumentSemanticSearch;
  private readonly getChunks?: (filters?: { sourceIds?: string[] }) => IndexedChunk[] | Promise<IndexedChunk[]>;

  constructor(options: HybridDocumentSearchOptions) {
    this.embeddingProvider = options.embeddingProvider;
    this.semanticSearch = options.semanticSearch ?? new DocumentSemanticSearch();
    this.getChunks = options.getChunks;
  }

  async search(
    query: string,
    chunks: IndexedChunk[],
    options?: DocumentSearchOptions,
  ): Promise<RankedChunk[]>;
  async search(
    query: string,
    topK: number,
    filters?: { sourceIds?: string[] },
  ): Promise<Result<DocumentSearchResult[]>>;
  async search(
    query: string,
    chunksOrTopK: IndexedChunk[] | number,
    optionsOrFilters?: DocumentSearchOptions | { sourceIds?: string[] },
  ): Promise<RankedChunk[] | Result<DocumentSearchResult[]>> {
    if (Array.isArray(chunksOrTopK)) {
      const options = optionsOrFilters as DocumentSearchOptions | undefined;
      return this.searchChunks(query, chunksOrTopK, options);
    }

    return this.searchAsProvider(query, chunksOrTopK, optionsOrFilters as { sourceIds?: string[] } | undefined);
  }

  private async searchChunks(
    query: string,
    chunks: IndexedChunk[],
    options?: DocumentSearchOptions,
  ): Promise<RankedChunk[]> {
    if (chunks.length === 0) {
      return [];
    }

    const topK = normalizeTopK(options?.topK);
    if (topK === 0) {
      return [];
    }

    const filteredChunks = chunks.filter((chunk) => isSourceMatch(chunk, options?.sourceFilter));
    if (filteredChunks.length === 0) {
      return [];
    }

    const keywordScores = buildKeywordScores(query, filteredChunks);
    const semanticScores = new Map<string, number>();

    let hasSemanticScores = false;
    const embeddingResult = await this.embeddingProvider.embed(query);
    if (embeddingResult.ok && embeddingResult.value instanceof Float32Array) {
      const semanticResults = this.semanticSearch.search(embeddingResult.value, filteredChunks, {
        topK: filteredChunks.length,
      });

      for (const result of semanticResults) {
        semanticScores.set(result.chunk.id, result.semanticScore);
      }

      hasSemanticScores = true;
    }

    const ranked: RankedChunk[] = [];
    for (const chunk of filteredChunks) {
      const semanticScore = semanticScores.get(chunk.id) ?? 0;
      const keywordScore = keywordScores.get(chunk.id) ?? 0;
      const score = hasSemanticScores
        ? SEMANTIC_WEIGHT * semanticScore + KEYWORD_WEIGHT * keywordScore
        : keywordScore;

      if (typeof options?.minScore === "number" && score < options.minScore) {
        continue;
      }

      ranked.push({
        chunk,
        score,
        semanticScore,
        keywordScore,
        source: {
          path: chunk.sourcePath,
          heading: chunk.heading,
        },
      });
    }

    ranked.sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.chunk.id.localeCompare(right.chunk.id);
    });

    return ranked.slice(0, topK);
  }

  private async searchAsProvider(
    query: string,
    topK: number,
    filters?: { sourceIds?: string[] },
  ): Promise<Result<DocumentSearchResult[]>> {
    if (!this.getChunks) {
      return ok([]);
    }

    try {
      const chunks = await this.getChunks(filters);
      const filteredChunks =
        filters?.sourceIds && filters.sourceIds.length > 0
          ? chunks.filter((chunk) => filters.sourceIds?.includes(chunk.sourceId))
          : chunks;

      const ranked = await this.searchChunks(query, filteredChunks, { topK });
      const results: DocumentSearchResult[] = ranked.map((item) => ({
        chunkId: item.chunk.id,
        content: item.chunk.content,
        score: item.score,
        sourcePath: item.chunk.sourcePath,
        heading: item.chunk.heading,
        headingHierarchy: item.chunk.headingHierarchy,
        sourceId: item.chunk.sourceId,
        chunkIndex: item.chunk.chunkIndex,
      }));

      return ok(results);
    } catch (error) {
      return err(
        new HybridDocumentSearchError(
          "Document search provider query failed",
          "HYBRID_DOCUMENT_SEARCH_PROVIDER_ERROR",
          asError(error),
        ),
      );
    }
  }
}
