import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type EmbeddingProvider,
  EmbeddingProviderError,
  ReindexService,
  SqliteEmbeddingReindexStorage,
  type EmbeddingProviderMetadata,
  type EmbeddingReindexStorage,
  type ValidationRecord,
  vectorToBlob,
} from "../../../src/memory/embeddings";
import { VectorRetriever } from "../../../src/memory/search/index";
import {
  SqliteMemoryDb,
  SqliteMemoryRepository,
  type CreateMemoryInput,
} from "../../../src/memory/storage";
import { err, ok, type Result } from "../../../src/result";

interface TestContext {
  rootDir: string;
  db: SqliteMemoryDb;
  repository: SqliteMemoryRepository;
}

const contexts: TestContext[] = [];

class KeywordEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimension: number;
  readonly version: string;

  private readonly failWhenIncludes: string | null;

  constructor(options: {
    id: string;
    model: string;
    dimension?: number;
    version?: string;
    failWhenIncludes?: string;
  }) {
    this.id = options.id;
    this.model = options.model;
    this.dimension = options.dimension ?? 4;
    this.version = options.version ?? "1";
    this.failWhenIncludes = options.failWhenIncludes ?? null;
  }

  async embed(text: string): Promise<Result<Float32Array, EmbeddingProviderError>> {
    if (this.failWhenIncludes && text.toLowerCase().includes(this.failWhenIncludes.toLowerCase())) {
      return err(new EmbeddingProviderError(`Embedding failed for '${text}'`));
    }

    return ok(this.makeVector(text));
  }

  async embedBatch(texts: string[]): Promise<Result<Float32Array[], EmbeddingProviderError>> {
    const vectors: Float32Array[] = [];

    for (const text of texts) {
      const embedded = await this.embed(text);
      if (!embedded.ok) {
        return embedded;
      }

      vectors.push(embedded.value);
    }

    return ok(vectors);
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  private makeVector(text: string): Float32Array {
    const normalized = text.toLowerCase();
    const typescript = normalized.includes("typescript") ? 1 : 0;
    const database = normalized.includes("database") ? 1 : 0;
    const deploy = normalized.includes("deploy") ? 1 : 0;
    const fallback = Math.min(1, Math.max(0, text.length / 100));
    return new Float32Array([typescript, database, deploy, fallback]);
  }
}

class CorruptingValidationStorage implements EmbeddingReindexStorage {
  private readonly delegate: EmbeddingReindexStorage;

  constructor(delegate: EmbeddingReindexStorage) {
    this.delegate = delegate;
  }

  async countRecords(provider: Pick<EmbeddingProviderMetadata, "provider" | "model">) {
    return this.delegate.countRecords(provider);
  }

  async listRecords(
    provider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
    offset: number,
    limit: number,
  ) {
    return this.delegate.listRecords(provider, offset, limit);
  }

  async replaceEmbedding(
    recordId: string,
    oldProvider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
    newProvider: EmbeddingProviderMetadata,
    vector: Float32Array,
  ) {
    return this.delegate.replaceEmbedding(recordId, oldProvider, newProvider, vector);
  }

  async listValidationRecords(
    provider: Pick<EmbeddingProviderMetadata, "provider" | "model">,
    limit: number,
  ): Promise<Result<ValidationRecord[], Error>> {
    const base = await this.delegate.listValidationRecords(provider, limit);
    if (!base.ok) {
      return base;
    }

    const corrupted = base.value.map((record) => ({
      ...record,
      vector: new Float32Array(record.vector.length).fill(0),
    }));

    return ok(corrupted);
  }
}

async function createTestContext(prefix: string): Promise<TestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const dbPath = join(rootDir, "memory.db");
  const dataDir = join(rootDir, "memory-files");

  await mkdir(dataDir, { recursive: true });

  const db = new SqliteMemoryDb({ dbPath });
  const initResult = db.initialize();
  expect(initResult.ok).toBe(true);
  if (!initResult.ok) {
    throw initResult.error;
  }

  const repository = new SqliteMemoryRepository({ db, dataDir });
  const context: TestContext = { rootDir, db, repository };
  contexts.push(context);
  return context;
}

function memoryInput(content: string): CreateMemoryInput {
  return {
    content,
    type: "fact",
    layer: "stm",
    importance: 0.7,
    confidence: 1,
    tags: [],
    entities: [],
    source: {
      type: "explicit",
      conversationId: "conv-provider-switch",
    },
  };
}

function insertEmbedding(
  db: SqliteMemoryDb,
  recordId: string,
  provider: EmbeddingProvider,
  vector: Float32Array,
): void {
  db.getDb()
    .query(
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
    )
    .run(
      randomUUID(),
      recordId,
      provider.id,
      provider.model,
      provider.dimension,
      provider.version,
      vectorToBlob(vector),
    );
}

afterEach(async () => {
  for (const context of contexts) {
    context.db.close();
    await rm(context.rootDir, { recursive: true, force: true });
  }

  contexts.length = 0;
});

describe("Provider switch reindex E2E", () => {
  test("reindexes embeddings to the new provider and preserves retrieval", async () => {
    const context = await createTestContext("provider-switch-success-");
    const oldProvider = new KeywordEmbeddingProvider({
      id: "provider-a",
      model: "embeddings-a",
    });
    const newProvider = new KeywordEmbeddingProvider({
      id: "provider-b",
      model: "embeddings-b",
    });

    const created = [
      await context.repository.create(memoryInput("TypeScript runtime notes")),
      await context.repository.create(memoryInput("Database migration checklist")),
      await context.repository.create(memoryInput("Deployment rollback guide")),
    ];

    for (const result of created) {
      expect(result.ok).toBe(true);
    }
    if (created.some((result) => !result.ok)) {
      return;
    }

    for (const result of created) {
      if (!result.ok) {
        return;
      }

      const vectorResult = await oldProvider.embed(result.value.content);
      expect(vectorResult.ok).toBe(true);
      if (!vectorResult.ok) {
        return;
      }

      insertEmbedding(context.db, result.value.id, oldProvider, vectorResult.value);
    }

    const progressEvents: Array<{ processed: number; total: number; phase: string }> = [];
    const service = new ReindexService({
      storage: new SqliteEmbeddingReindexStorage({ db: context.db }),
      oldProvider: { provider: oldProvider.id, model: oldProvider.model },
      newProvider,
    });

    const reindexResult = await service.reindex({
      batchSize: 2,
      onProgress(progress) {
        progressEvents.push({
          processed: progress.processed,
          total: progress.totalRecords,
          phase: progress.phase,
        });
      },
      validateAfterReindex: true,
    });

    expect(reindexResult.ok).toBe(true);
    if (!reindexResult.ok) {
      return;
    }

    expect(reindexResult.value.totalRecords).toBe(3);
    expect(reindexResult.value.reindexed).toBe(3);
    expect(reindexResult.value.failed).toBe(0);
    expect(reindexResult.value.validation.performed).toBe(true);
    expect(reindexResult.value.validation.passed).toBe(true);

    const oldCount = context.db
      .getDb()
      .query("SELECT COUNT(*) as count FROM memory_embeddings WHERE provider = ?1")
      .get(oldProvider.id) as { count: number };
    const newCount = context.db
      .getDb()
      .query("SELECT COUNT(*) as count FROM memory_embeddings WHERE provider = ?1")
      .get(newProvider.id) as { count: number };

    expect(oldCount.count).toBe(0);
    expect(newCount.count).toBe(3);

    const retriever = new VectorRetriever({
      db: context.db,
      embeddingProvider: newProvider,
    });

    const searchResult = await retriever.search("TypeScript runtime");
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) {
      return;
    }

    expect(searchResult.value.length).toBeGreaterThan(0);
    expect(searchResult.value[0]?.content).toContain("TypeScript");
    expect(progressEvents.some((event) => event.phase === "reindex")).toBe(true);
    expect(progressEvents.some((event) => event.phase === "validation")).toBe(true);
  });

  test("continues processing when some records fail to reindex", async () => {
    const context = await createTestContext("provider-switch-partial-");
    const oldProvider = new KeywordEmbeddingProvider({
      id: "provider-a",
      model: "embeddings-a",
    });
    const newProvider = new KeywordEmbeddingProvider({
      id: "provider-b",
      model: "embeddings-b",
      failWhenIncludes: "deployment",
    });

    const created = [
      await context.repository.create(memoryInput("TypeScript runtime notes")),
      await context.repository.create(memoryInput("Database migration checklist")),
      await context.repository.create(memoryInput("Deployment rollback guide")),
    ];

    for (const result of created) {
      expect(result.ok).toBe(true);
    }
    if (created.some((result) => !result.ok)) {
      return;
    }

    for (const result of created) {
      if (!result.ok) {
        return;
      }

      const vectorResult = await oldProvider.embed(result.value.content);
      expect(vectorResult.ok).toBe(true);
      if (!vectorResult.ok) {
        return;
      }

      insertEmbedding(context.db, result.value.id, oldProvider, vectorResult.value);
    }

    const progressEvents: number[] = [];
    const service = new ReindexService({
      storage: new SqliteEmbeddingReindexStorage({ db: context.db }),
      oldProvider: { provider: oldProvider.id, model: oldProvider.model },
      newProvider,
    });

    const reindexResult = await service.reindex({
      batchSize: 3,
      onProgress(progress) {
        if (progress.phase === "reindex") {
          progressEvents.push(progress.processed);
        }
      },
      validateAfterReindex: false,
    });

    expect(reindexResult.ok).toBe(true);
    if (!reindexResult.ok) {
      return;
    }

    expect(reindexResult.value.totalRecords).toBe(3);
    expect(reindexResult.value.reindexed).toBe(2);
    expect(reindexResult.value.failed).toBe(1);
    expect(reindexResult.value.failedRecordIds.length).toBe(1);
    expect(progressEvents).toEqual([1, 2, 3]);

    const newCount = context.db
      .getDb()
      .query("SELECT COUNT(*) as count FROM memory_embeddings WHERE provider = ?1")
      .get(newProvider.id) as { count: number };
    const oldCount = context.db
      .getDb()
      .query("SELECT COUNT(*) as count FROM memory_embeddings WHERE provider = ?1")
      .get(oldProvider.id) as { count: number };

    expect(newCount.count).toBe(2);
    expect(oldCount.count).toBe(1);
  });

  test("fails when post-reindex validation detects vector mismatch", async () => {
    const context = await createTestContext("provider-switch-validation-");
    const oldProvider = new KeywordEmbeddingProvider({
      id: "provider-a",
      model: "embeddings-a",
    });
    const newProvider = new KeywordEmbeddingProvider({
      id: "provider-b",
      model: "embeddings-b",
    });

    const created = await context.repository.create(memoryInput("TypeScript runtime notes"));
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const oldVector = await oldProvider.embed(created.value.content);
    expect(oldVector.ok).toBe(true);
    if (!oldVector.ok) {
      return;
    }

    insertEmbedding(context.db, created.value.id, oldProvider, oldVector.value);

    const baseStorage = new SqliteEmbeddingReindexStorage({ db: context.db });
    const service = new ReindexService({
      storage: new CorruptingValidationStorage(baseStorage),
      oldProvider: { provider: oldProvider.id, model: oldProvider.model },
      newProvider,
    });

    const reindexResult = await service.reindex({
      validateAfterReindex: true,
      validationSampleSize: 1,
      minValidationSimilarity: 0.9,
    });

    expect(reindexResult.ok).toBe(false);
    if (!reindexResult.ok) {
      expect(reindexResult.error.code).toBe("EMBEDDING_REINDEX_VALIDATION_FAILED");
    }
  });
});
