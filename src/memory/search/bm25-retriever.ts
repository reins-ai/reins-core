import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type {
  MemoryLayer,
  MemorySourceType,
  MemoryType,
  PersistedMemoryLayer,
} from "../types/index";
import type { SqliteMemoryDb } from "../storage/sqlite-memory-db";
import { parseSearchQuery } from "./search-query-parser";

export class BM25RetrieverError extends ReinsError {
  constructor(message: string, code = "BM25_RETRIEVER_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "BM25RetrieverError";
  }
}

export interface BM25SearchOptions {
  limit?: number;
  minScore?: number;
  sourceTypes?: MemorySourceType[];
  memoryTypes?: MemoryType[];
  layers?: MemoryLayer[];
}

export interface BM25SearchResult {
  memoryId: string;
  content: string;
  type: MemoryType;
  layer: PersistedMemoryLayer;
  importance: number;
  bm25Score: number;
  snippet: string;
}

interface FtsResultRow {
  id: string;
  content: string;
  type: string;
  layer: string;
  importance: number;
  source_type: string;
  bm25_score: number;
  snippet: string;
}

const DEFAULT_LIMIT = 20;

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

/**
 * Normalize raw FTS5 BM25 scores to a 0-1 range using min-max normalization.
 *
 * FTS5 rank values are negative (more negative = more relevant).
 * After normalization, 1.0 = most relevant, 0.0 = least relevant.
 *
 * When all scores are identical, returns 1.0 for every result.
 */
export function normalizeBM25Scores(results: BM25SearchResult[]): BM25SearchResult[] {
  if (results.length === 0) {
    return [];
  }

  if (results.length === 1) {
    return [{ ...results[0], bm25Score: 1.0 }];
  }

  const rawScores = results.map((r) => r.bm25Score);
  const minRaw = Math.min(...rawScores);
  const maxRaw = Math.max(...rawScores);
  const range = maxRaw - minRaw;

  if (range === 0) {
    return results.map((r) => ({ ...r, bm25Score: 1.0 }));
  }

  // FTS5 rank: more negative = more relevant.
  // Invert so that the most negative (best) maps to 1.0.
  return results.map((r) => ({
    ...r,
    bm25Score: (maxRaw - r.bm25Score) / range,
  }));
}

export interface BM25RetrieverOptions {
  db: SqliteMemoryDb;
}

export class BM25Retriever {
  private readonly db: SqliteMemoryDb;

  constructor(options: BM25RetrieverOptions) {
    this.db = options.db;
  }

  search(query: string, options?: BM25SearchOptions): Result<BM25SearchResult[], BM25RetrieverError> {
    const parsed = parseSearchQuery(query);
    if (!parsed) {
      return ok([]);
    }

    const limit = options?.limit ?? DEFAULT_LIMIT;

    try {
      const db = this.db.getDb();

      const whereClauses: string[] = ["memory_fts MATCH ?1"];
      const params: Array<string | number> = [parsed];

      let paramIndex = 2;

      if (options?.memoryTypes && options.memoryTypes.length > 0) {
        const placeholders = options.memoryTypes.map(() => `?${paramIndex++}`).join(", ");
        whereClauses.push(`m.type IN (${placeholders})`);
        params.push(...options.memoryTypes);
      }

      if (options?.layers && options.layers.length > 0) {
        const placeholders = options.layers.map(() => `?${paramIndex++}`).join(", ");
        whereClauses.push(`m.layer IN (${placeholders})`);
        params.push(...options.layers);
      }

      if (options?.sourceTypes && options.sourceTypes.length > 0) {
        const placeholders = options.sourceTypes.map(() => `?${paramIndex++}`).join(", ");
        whereClauses.push(`m.source_type IN (${placeholders})`);
        params.push(...options.sourceTypes);
      }

      const whereClause = whereClauses.join(" AND ");

      const sql = `
        SELECT
          m.id,
          m.content,
          m.type,
          m.layer,
          m.importance,
          m.source_type,
          memory_fts.rank AS bm25_score,
          snippet(memory_fts, 1, '>>>', '<<<', '...', 32) AS snippet
        FROM memory_fts
        JOIN memories m ON m.id = memory_fts.memory_id
        WHERE ${whereClause}
        ORDER BY memory_fts.rank
        LIMIT ?${paramIndex}
      `;

      params.push(limit);

      const rows = db.query(sql).all(...params) as FtsResultRow[];

      let results: BM25SearchResult[] = rows.map((row) => ({
        memoryId: row.id,
        content: row.content,
        type: row.type as MemoryType,
        layer: row.layer as PersistedMemoryLayer,
        importance: row.importance,
        bm25Score: row.bm25_score,
        snippet: row.snippet,
      }));

      if (typeof options?.minScore === "number") {
        const threshold = options.minScore;
        // Filter before normalization: FTS5 rank is negative, more negative = better.
        // We normalize first, then filter by the 0-1 score.
        results = normalizeBM25Scores(results);
        results = results.filter((r) => r.bm25Score >= threshold);
        return ok(results);
      }

      results = normalizeBM25Scores(results);
      return ok(results);
    } catch (cause) {
      return err(
        new BM25RetrieverError(
          "BM25 search query failed",
          "BM25_RETRIEVER_QUERY_ERROR",
          asError(cause),
        ),
      );
    }
  }
}
