import { Buffer } from "node:buffer";

import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import { blobToVector, type EmbeddingProvider } from "../embeddings/embedding-provider";
import type { SqliteMemoryDb } from "../storage/sqlite-memory-db";
import type { MemoryLayer, MemoryType } from "../types/index";
import { cosineSimilarity } from "./vector-distance";

export interface VectorSearchOptions {
  limit?: number;
  minSimilarity?: number;
  memoryTypes?: MemoryType[];
  layers?: MemoryLayer[];
  providerFilter?: string;
}

export interface VectorSearchResult {
  memoryId: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  importance: number;
  similarity: number;
  embeddingMetadata: {
    provider: string;
    model: string;
    dimension: number;
  };
}

export interface VectorRetrieverOptions {
  db: SqliteMemoryDb;
  embeddingProvider: EmbeddingProvider;
}

interface VectorCandidateRow {
  memory_id: string;
  content: string;
  type: string;
  layer: string;
  importance: number;
  provider: string;
  model: string;
  dimension: number;
  vector: Buffer | Uint8Array | ArrayBuffer;
}

const DEFAULT_LIMIT = 20;

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

function normalizeProviderFilter(providerFilter: string | undefined, fallbackProvider: string): string {
  const normalized = providerFilter?.trim();
  if (!normalized) {
    return fallbackProvider;
  }

  return normalized;
}

function validateSearchOptions(options: VectorSearchOptions | undefined): Result<void, VectorRetrieverError> {
  if (!options) {
    return ok(undefined);
  }

  if (typeof options.limit !== "undefined") {
    if (!Number.isInteger(options.limit) || options.limit <= 0) {
      return err(
        new VectorRetrieverError(
          "Vector search option 'limit' must be a positive integer",
          "VECTOR_RETRIEVER_INVALID_OPTIONS",
        ),
      );
    }
  }

  if (typeof options.minSimilarity !== "undefined") {
    const { minSimilarity } = options;
    if (!Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
      return err(
        new VectorRetrieverError(
          "Vector search option 'minSimilarity' must be between 0 and 1",
          "VECTOR_RETRIEVER_INVALID_OPTIONS",
        ),
      );
    }
  }

  return ok(undefined);
}

function normalizeSimilarity(similarity: number): number {
  if (similarity <= 0) {
    return 0;
  }

  if (similarity >= 1) {
    return 1;
  }

  return similarity;
}

function asBuffer(blob: Buffer | Uint8Array | ArrayBuffer): Buffer {
  if (Buffer.isBuffer(blob)) {
    return blob;
  }

  if (blob instanceof ArrayBuffer) {
    return Buffer.from(blob);
  }

  return Buffer.from(blob);
}

export class VectorRetrieverError extends ReinsError {
  constructor(message: string, code = "VECTOR_RETRIEVER_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "VectorRetrieverError";
  }
}

export class VectorRetriever {
  private readonly db: SqliteMemoryDb;
  private readonly embeddingProvider: EmbeddingProvider;

  constructor(options: VectorRetrieverOptions) {
    this.db = options.db;
    this.embeddingProvider = options.embeddingProvider;
  }

  async search(
    query: string,
    options?: VectorSearchOptions,
  ): Promise<Result<VectorSearchResult[], VectorRetrieverError>> {
    const trimmedQuery = query.trim();
    if (trimmedQuery.length === 0) {
      return ok([]);
    }

    const optionsResult = validateSearchOptions(options);
    if (!optionsResult.ok) {
      return optionsResult;
    }

    const embeddingResult = await this.embeddingProvider.embed(trimmedQuery);
    if (!embeddingResult.ok) {
      return err(
        new VectorRetrieverError(
          `Failed to generate query embedding with provider '${this.embeddingProvider.id}' and model '${this.embeddingProvider.model}'`,
          "VECTOR_RETRIEVER_EMBEDDING_FAILED",
          embeddingResult.error,
        ),
      );
    }

    const queryVector = embeddingResult.value;
    const expectedDimension = queryVector.length;

    try {
      const db = this.db.getDb();

      const limit = options?.limit ?? DEFAULT_LIMIT;
      const minSimilarity = options?.minSimilarity;
      const providerFilter = normalizeProviderFilter(options?.providerFilter, this.embeddingProvider.id);

      const whereClauses: string[] = [
        "e.provider = ?1",
        "e.model = ?2",
      ];
      const params: Array<string | number> = [providerFilter, this.embeddingProvider.model];
      let paramIndex = 3;

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

      const sql = `
        SELECT
          e.memory_id,
          e.provider,
          e.model,
          e.dimension,
          e.vector,
          m.content,
          m.type,
          m.layer,
          m.importance
        FROM memory_embeddings e
        JOIN memories m ON m.id = e.memory_id
        WHERE ${whereClauses.join(" AND ")}
      `;

      const rows = db.query(sql).all(...params) as VectorCandidateRow[];
      if (rows.length === 0) {
        return ok([]);
      }

      const results: VectorSearchResult[] = [];

      for (const row of rows) {
        const vector = blobToVector(asBuffer(row.vector));
        if (row.dimension !== expectedDimension || vector.length !== expectedDimension) {
          return err(
            new VectorRetrieverError(
              `Dimension mismatch for memory '${row.memory_id}': query dimension ${expectedDimension} from ${this.embeddingProvider.id}/${this.embeddingProvider.model}, stored dimension ${row.dimension} from ${row.provider}/${row.model}`,
              "VECTOR_RETRIEVER_DIMENSION_MISMATCH",
            ),
          );
        }

        const similarity = normalizeSimilarity(cosineSimilarity(queryVector, vector));
        if (typeof minSimilarity === "number" && similarity < minSimilarity) {
          continue;
        }

        results.push({
          memoryId: row.memory_id,
          content: row.content,
          type: row.type as MemoryType,
          layer: row.layer as MemoryLayer,
          importance: row.importance,
          similarity,
          embeddingMetadata: {
            provider: row.provider,
            model: row.model,
            dimension: row.dimension,
          },
        });
      }

      results.sort((left, right) => right.similarity - left.similarity);
      return ok(results.slice(0, limit));
    } catch (cause) {
      return err(
        new VectorRetrieverError(
          "Vector similarity search failed",
          "VECTOR_RETRIEVER_QUERY_FAILED",
          asError(cause),
        ),
      );
    }
  }
}
