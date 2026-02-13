import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import { cosineSimilarity } from "../search/vector-distance";
import type { SqliteMemoryDb } from "../storage/sqlite-memory-db";
import {
  vectorToBlob,
  type EmbeddingProvider,
  type EmbeddingProviderMetadata,
} from "./embedding-provider";

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_VALIDATION_SAMPLE_SIZE = 5;
const DEFAULT_MIN_VALIDATION_SIMILARITY = 0.95;

interface ReindexRow {
  memory_id: string;
  content: string;
}

interface CountRow {
  count: number;
}

interface ValidationRow {
  memory_id: string;
  content: string;
  vector: Buffer | Uint8Array | ArrayBuffer;
}

export interface ReindexRecord {
  id: string;
  content: string;
}

export interface ValidationRecord {
  id: string;
  content: string;
  vector: Float32Array;
}

export interface ReindexProgress {
  phase: "reindex" | "validation";
  totalRecords: number;
  processed: number;
  reindexed: number;
  failed: number;
  currentRecordId?: string;
}

export interface ReindexConfig {
  batchSize?: number;
  onProgress?: (progress: ReindexProgress) => void;
  validateAfterReindex?: boolean;
  validationSampleSize?: number;
  minValidationSimilarity?: number;
}

export interface ReindexResult {
  totalRecords: number;
  reindexed: number;
  failed: number;
  durationMs: number;
  failedRecordIds: string[];
  newProvider: EmbeddingProviderMetadata;
  validation: {
    performed: boolean;
    passed: boolean;
    sampleSize: number;
    minSimilarity: number;
    failedRecordIds: string[];
  };
}

export interface EmbeddingReindexStorage {
  countRecords(provider: Pick<EmbeddingProviderMetadata, "provider" | "model">): Promise<Result<number, ReindexServiceError>>;
  listRecords(
    provider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
    offset: number,
    limit: number,
  ): Promise<Result<ReindexRecord[], ReindexServiceError>>;
  replaceEmbedding(
    recordId: string,
    oldProvider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
    newProvider: EmbeddingProviderMetadata,
    vector: Float32Array,
  ): Promise<Result<void, ReindexServiceError>>;
  listValidationRecords(
    provider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
    limit: number,
  ): Promise<Result<ValidationRecord[], ReindexServiceError>>;
}

export interface SqliteEmbeddingReindexStorageOptions {
  db: SqliteMemoryDb;
}

export class ReindexServiceError extends ReinsError {
  constructor(message: string, code = "EMBEDDING_REINDEX_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "ReindexServiceError";
  }
}

export class SqliteEmbeddingReindexStorage implements EmbeddingReindexStorage {
  private readonly db: SqliteMemoryDb;

  constructor(options: SqliteEmbeddingReindexStorageOptions) {
    this.db = options.db;
  }

  async countRecords(
    provider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
  ): Promise<Result<number, ReindexServiceError>> {
    try {
      const row = this.db
        .getDb()
        .query(
          `
            SELECT COUNT(*) as count
            FROM memory_embeddings
            WHERE provider = ?1 AND model = ?2
          `,
        )
        .get(provider.provider, provider.model) as CountRow;

      return ok(row.count);
    } catch (cause) {
      return err(
        new ReindexServiceError(
          "Failed to count embeddings for reindex",
          "EMBEDDING_REINDEX_COUNT_FAILED",
          asError(cause),
        ),
      );
    }
  }

  async listRecords(
    provider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
    offset: number,
    limit: number,
  ): Promise<Result<ReindexRecord[], ReindexServiceError>> {
    try {
      const rows = this.db
        .getDb()
        .query(
          `
            SELECT e.memory_id, m.content
            FROM memory_embeddings e
            JOIN memories m ON m.id = e.memory_id
            WHERE e.provider = ?1 AND e.model = ?2
            ORDER BY e.created_at ASC, e.memory_id ASC
            LIMIT ?3 OFFSET ?4
          `,
        )
        .all(provider.provider, provider.model, limit, offset) as ReindexRow[];

      return ok(
        rows.map((row) => ({
          id: row.memory_id,
          content: row.content,
        })),
      );
    } catch (cause) {
      return err(
        new ReindexServiceError(
          "Failed to load embeddings for reindex",
          "EMBEDDING_REINDEX_LIST_FAILED",
          asError(cause),
        ),
      );
    }
  }

  async replaceEmbedding(
    recordId: string,
    oldProvider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
    newProvider: EmbeddingProviderMetadata,
    vector: Float32Array,
  ): Promise<Result<void, ReindexServiceError>> {
    const db = this.db.getDb();

    try {
      db.exec("BEGIN IMMEDIATE");
      db.query(
        `
          DELETE FROM memory_embeddings
          WHERE memory_id = ?1 AND provider = ?2 AND model = ?3
        `,
      ).run(recordId, oldProvider.provider, oldProvider.model);

      db.query(
        `
          INSERT INTO memory_embeddings (
            id,
            memory_id,
            provider,
            model,
            dimension,
            version,
            vector
          ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        `,
      ).run(
        randomUUID(),
        recordId,
        newProvider.provider,
        newProvider.model,
        newProvider.dimension,
        newProvider.version,
        vectorToBlob(vector),
      );

      db.exec("COMMIT");
      return ok(undefined);
    } catch (cause) {
      rollback(db);
      return err(
        new ReindexServiceError(
          `Failed to replace embedding for memory '${recordId}'`,
          "EMBEDDING_REINDEX_REPLACE_FAILED",
          asError(cause),
        ),
      );
    }
  }

  async listValidationRecords(
    provider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
    limit: number,
  ): Promise<Result<ValidationRecord[], ReindexServiceError>> {
    try {
      const rows = this.db
        .getDb()
        .query(
          `
            SELECT e.memory_id, m.content, e.vector
            FROM memory_embeddings e
            JOIN memories m ON m.id = e.memory_id
            WHERE e.provider = ?1 AND e.model = ?2
            ORDER BY e.created_at DESC, e.memory_id ASC
            LIMIT ?3
          `,
        )
        .all(provider.provider, provider.model, limit) as ValidationRow[];

      return ok(
        rows.map((row) => ({
          id: row.memory_id,
          content: row.content,
          vector: blobToVector(asBuffer(row.vector)),
        })),
      );
    } catch (cause) {
      return err(
        new ReindexServiceError(
          "Failed to load validation records for reindex",
          "EMBEDDING_REINDEX_VALIDATION_LOAD_FAILED",
          asError(cause),
        ),
      );
    }
  }
}

export interface ReindexServiceOptions {
  storage: EmbeddingReindexStorage;
  oldProvider: Pick<EmbeddingProviderMetadata, "provider" | "model">;
  newProvider: EmbeddingProvider;
  now?: () => Date;
}

export class ReindexService {
  private readonly storage: EmbeddingReindexStorage;
  private readonly oldProvider: Pick<EmbeddingProviderMetadata, "provider" | "model">;
  private readonly newProvider: EmbeddingProvider;
  private readonly now: () => Date;

  constructor(options: ReindexServiceOptions) {
    this.storage = options.storage;
    this.oldProvider = options.oldProvider;
    this.newProvider = options.newProvider;
    this.now = options.now ?? (() => new Date());
  }

  async reindex(config: ReindexConfig = {}): Promise<Result<ReindexResult, ReindexServiceError>> {
    const start = this.now();
    const batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    const validateAfterReindex = config.validateAfterReindex ?? true;
    const validationSampleSize = config.validationSampleSize ?? DEFAULT_VALIDATION_SAMPLE_SIZE;
    const minValidationSimilarity = config.minValidationSimilarity ?? DEFAULT_MIN_VALIDATION_SIMILARITY;

    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      return err(
        new ReindexServiceError(
          "batchSize must be a positive integer",
          "EMBEDDING_REINDEX_INVALID_CONFIG",
        ),
      );
    }

    if (!Number.isInteger(validationSampleSize) || validationSampleSize <= 0) {
      return err(
        new ReindexServiceError(
          "validationSampleSize must be a positive integer",
          "EMBEDDING_REINDEX_INVALID_CONFIG",
        ),
      );
    }

    if (!Number.isFinite(minValidationSimilarity) || minValidationSimilarity < -1 || minValidationSimilarity > 1) {
      return err(
        new ReindexServiceError(
          "minValidationSimilarity must be between -1 and 1",
          "EMBEDDING_REINDEX_INVALID_CONFIG",
        ),
      );
    }

    const totalResult = await this.storage.countRecords(this.oldProvider);
    if (!totalResult.ok) {
      return totalResult;
    }

    const totalRecords = totalResult.value;
    let processed = 0;
    let reindexed = 0;
    let failed = 0;
    const failedRecordIds: string[] = [];

    while (processed < totalRecords) {
      const recordsResult = await this.storage.listRecords(this.oldProvider, 0, batchSize);
      if (!recordsResult.ok) {
        return recordsResult;
      }

      const records = recordsResult.value;
      if (records.length === 0) {
        break;
      }

      const batchResult = await this.newProvider.embedBatch(records.map((record) => record.content));
      if (batchResult.ok && batchResult.value.length === records.length) {
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index];
          const vector = batchResult.value[index];
          const replaced = await this.replaceSingle(record, vector);

          processed += 1;
          if (replaced.ok) {
            reindexed += 1;
          } else {
            failed += 1;
            failedRecordIds.push(record.id);
          }

          publishProgress(config.onProgress, {
            phase: "reindex",
            totalRecords,
            processed,
            reindexed,
            failed,
            currentRecordId: record.id,
          });
        }

        continue;
      }

      for (const record of records) {
        const embedded = await this.newProvider.embed(record.content);
        let recordSucceeded = false;
        if (embedded.ok) {
          const replaced = await this.replaceSingle(record, embedded.value);
          recordSucceeded = replaced.ok;
        }

        processed += 1;
        if (recordSucceeded) {
          reindexed += 1;
        } else {
          failed += 1;
          failedRecordIds.push(record.id);
        }

        publishProgress(config.onProgress, {
          phase: "reindex",
          totalRecords,
          processed,
          reindexed,
          failed,
          currentRecordId: record.id,
        });
      }
    }

    let validationPassed = true;
    const validationFailedRecordIds: string[] = [];
    let validationPerformed = false;
    let validationSampleCount = 0;

    if (validateAfterReindex && reindexed > 0) {
      validationPerformed = true;
      const sampleSize = Math.min(validationSampleSize, reindexed);
      const validationRecordsResult = await this.storage.listValidationRecords(
        {
          provider: this.newProvider.id,
          model: this.newProvider.model,
        },
        sampleSize,
      );

      if (!validationRecordsResult.ok) {
        return validationRecordsResult;
      }

      const validationRecords = validationRecordsResult.value;
      validationSampleCount = validationRecords.length;

      for (let index = 0; index < validationRecords.length; index += 1) {
        const record = validationRecords[index];
        const embedded = await this.newProvider.embed(record.content);
        if (!embedded.ok) {
          validationPassed = false;
          validationFailedRecordIds.push(record.id);
        } else {
          const similarity = cosineSimilarity(embedded.value, record.vector);
          if (similarity < minValidationSimilarity) {
            validationPassed = false;
            validationFailedRecordIds.push(record.id);
          }
        }

        publishProgress(config.onProgress, {
          phase: "validation",
          totalRecords: validationRecords.length,
          processed: index + 1,
          reindexed,
          failed,
          currentRecordId: record.id,
        });
      }

      if (!validationPassed) {
        return err(
          new ReindexServiceError(
            `Reindex validation failed for ${validationFailedRecordIds.length} record(s)`,
            "EMBEDDING_REINDEX_VALIDATION_FAILED",
          ),
        );
      }
    }

    return ok({
      totalRecords,
      reindexed,
      failed,
      durationMs: elapsedMs(start, this.now()),
      failedRecordIds,
      newProvider: {
        provider: this.newProvider.id,
        model: this.newProvider.model,
        dimension: this.newProvider.dimension,
        version: this.newProvider.version,
      },
      validation: {
        performed: validationPerformed,
        passed: validationPassed,
        sampleSize: validationSampleCount,
        minSimilarity: minValidationSimilarity,
        failedRecordIds: validationFailedRecordIds,
      },
    });
  }

  private async replaceSingle(
    record: ReindexRecord,
    vector: Float32Array,
  ): Promise<Result<void, ReindexServiceError>> {
    if (vector.length !== this.newProvider.dimension) {
      return err(
        new ReindexServiceError(
          `Embedding dimension mismatch for '${record.id}': expected ${this.newProvider.dimension}, got ${vector.length}`,
          "EMBEDDING_REINDEX_DIMENSION_MISMATCH",
        ),
      );
    }

    return this.storage.replaceEmbedding(
      record.id,
      this.oldProvider,
      {
        provider: this.newProvider.id,
        model: this.newProvider.model,
        dimension: this.newProvider.dimension,
        version: this.newProvider.version,
      },
      vector,
    );
  }
}

function elapsedMs(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
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

function blobToVector(blob: Buffer): Float32Array {
  const start = blob.byteOffset;
  const end = blob.byteOffset + blob.byteLength;
  const arrayBuffer = blob.buffer.slice(start, end);
  return new Float32Array(arrayBuffer);
}

function rollback(db: ReturnType<SqliteMemoryDb["getDb"]>): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // no-op
  }
}

function publishProgress(
  onProgress: ((progress: ReindexProgress) => void) | undefined,
  progress: ReindexProgress,
): void {
  if (!onProgress) {
    return;
  }

  onProgress(progress);
}
