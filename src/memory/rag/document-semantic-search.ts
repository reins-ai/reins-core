import { cosineSimilarity } from "../search/vector-distance";

import type { IndexedChunk } from "./document-indexer";

const DEFAULT_TOP_K = 10;

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
