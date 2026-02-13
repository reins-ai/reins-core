import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok, type Result } from "../../../src/result";
import {
  EmbeddingProviderError,
  vectorToBlob,
  type EmbeddingProvider,
} from "../../../src/memory/embeddings/embedding-provider";
import {
  VectorRetriever,
  cosineSimilarity,
  dotProduct,
  magnitude,
} from "../../../src/memory/search/index";
import {
  SqliteMemoryDb,
  SqliteMemoryRepository,
  type CreateMemoryInput,
} from "../../../src/memory/storage/index";

interface TestContext {
  rootDir: string;
  db: SqliteMemoryDb;
  repository: SqliteMemoryRepository;
}

const contexts: TestContext[] = [];

class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimension: number;
  readonly version: string;

  private readonly embeddings: Map<string, Float32Array>;

  constructor(options: {
    id?: string;
    model?: string;
    dimension: number;
    version?: string;
    embeddings: Record<string, Float32Array>;
  }) {
    this.id = options.id ?? "mock-provider";
    this.model = options.model ?? "mock-model";
    this.dimension = options.dimension;
    this.version = options.version ?? "1";
    this.embeddings = new Map(Object.entries(options.embeddings));
  }

  async embed(text: string): Promise<Result<Float32Array, EmbeddingProviderError>> {
    const vector = this.embeddings.get(text);
    if (!vector) {
      return err(
        new EmbeddingProviderError(
          `No embedding registered for query '${text}'`,
          "EMBEDDING_PROVIDER_REQUEST_FAILED",
        ),
      );
    }

    return ok(vector);
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

  const repository = new SqliteMemoryRepository({
    db,
    dataDir,
  });

  const context: TestContext = {
    rootDir,
    db,
    repository,
  };

  contexts.push(context);
  return context;
}

function createMemoryInput(content: string): CreateMemoryInput {
  return {
    content,
    type: "fact",
    layer: "stm",
    importance: 0.5,
    confidence: 1,
    tags: [],
    entities: [],
    source: {
      type: "explicit",
      conversationId: "test-conv",
    },
  };
}

function insertEmbedding(
  db: SqliteMemoryDb,
  options: {
    memoryId: string;
    provider: string;
    model: string;
    dimension: number;
    version?: string;
    vector: Float32Array;
  },
): void {
  const sqlite = db.getDb();
  sqlite.query(
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
    options.memoryId,
    options.provider,
    options.model,
    options.dimension,
    options.version ?? "1",
    vectorToBlob(options.vector),
  );
}

afterEach(async () => {
  for (const context of contexts) {
    context.db.close();
    await rm(context.rootDir, { recursive: true, force: true });
  }

  contexts.length = 0;
});

describe("vector-distance", () => {
  test("calculates dot product and magnitude", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);

    expect(dotProduct(a, b)).toBe(32);
    expect(magnitude(a)).toBeCloseTo(Math.sqrt(14), 6);
  });

  test("calculates cosine similarity for known vectors", () => {
    const sameA = new Float32Array([1, 0, 0]);
    const sameB = new Float32Array([1, 0, 0]);
    const orthogonal = new Float32Array([0, 1, 0]);

    expect(cosineSimilarity(sameA, sameB)).toBeCloseTo(1, 6);
    expect(cosineSimilarity(sameA, orthogonal)).toBeCloseTo(0, 6);
  });
});

describe("VectorRetriever", () => {
  test("returns ranked results by cosine similarity", async () => {
    const context = await createTestContext("vector-ranked-");
    const provider = new MockEmbeddingProvider({
      id: "mock-provider",
      model: "mock-model",
      dimension: 3,
      embeddings: {
        "typescript memory": new Float32Array([1, 0, 0]),
      },
    });

    const retriever = new VectorRetriever({
      db: context.db,
      embeddingProvider: provider,
    });

    const first = await context.repository.create(createMemoryInput("TypeScript is useful for strict typing."));
    const second = await context.repository.create(createMemoryInput("TypeScript works with Bun."));
    const third = await context.repository.create(createMemoryInput("Completely unrelated gardening tip."));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) {
      return;
    }

    insertEmbedding(context.db, {
      memoryId: first.value.id,
      provider: "mock-provider",
      model: "mock-model",
      dimension: 3,
      vector: new Float32Array([1, 0, 0]),
    });
    insertEmbedding(context.db, {
      memoryId: second.value.id,
      provider: "mock-provider",
      model: "mock-model",
      dimension: 3,
      vector: new Float32Array([0.8, 0.2, 0]),
    });
    insertEmbedding(context.db, {
      memoryId: third.value.id,
      provider: "mock-provider",
      model: "mock-model",
      dimension: 3,
      vector: new Float32Array([0, 1, 0]),
    });

    const result = await retriever.search("typescript memory");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBe(3);
    expect(result.value[0]?.memoryId).toBe(first.value.id);
    expect(result.value[1]?.memoryId).toBe(second.value.id);
    expect(result.value[2]?.memoryId).toBe(third.value.id);
    expect(result.value[0]?.similarity ?? 0).toBeGreaterThan(result.value[1]?.similarity ?? 0);
    expect(result.value[1]?.similarity ?? 0).toBeGreaterThanOrEqual(result.value[2]?.similarity ?? 0);
    expect(result.value[0]?.embeddingMetadata.provider).toBe("mock-provider");
    expect(result.value[0]?.embeddingMetadata.model).toBe("mock-model");
    expect(result.value[0]?.embeddingMetadata.dimension).toBe(3);
  });

  test("applies minSimilarity threshold", async () => {
    const context = await createTestContext("vector-threshold-");
    const provider = new MockEmbeddingProvider({
      id: "mock-provider",
      model: "mock-model",
      dimension: 3,
      embeddings: {
        "threshold query": new Float32Array([1, 0, 0]),
      },
    });

    const retriever = new VectorRetriever({
      db: context.db,
      embeddingProvider: provider,
    });

    const strong = await context.repository.create(createMemoryInput("Strong semantic match"));
    const weak = await context.repository.create(createMemoryInput("Weak semantic match"));
    expect(strong.ok).toBe(true);
    expect(weak.ok).toBe(true);
    if (!strong.ok || !weak.ok) {
      return;
    }

    insertEmbedding(context.db, {
      memoryId: strong.value.id,
      provider: "mock-provider",
      model: "mock-model",
      dimension: 3,
      vector: new Float32Array([1, 0, 0]),
    });
    insertEmbedding(context.db, {
      memoryId: weak.value.id,
      provider: "mock-provider",
      model: "mock-model",
      dimension: 3,
      vector: new Float32Array([0.2, 0.98, 0]),
    });

    const result = await retriever.search("threshold query", { minSimilarity: 0.9 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBe(1);
    expect(result.value[0]?.memoryId).toBe(strong.value.id);
  });

  test("supports provider filter", async () => {
    const context = await createTestContext("vector-provider-filter-");
    const provider = new MockEmbeddingProvider({
      id: "provider-a",
      model: "shared-model",
      dimension: 3,
      embeddings: {
        "provider query": new Float32Array([1, 0, 0]),
      },
    });

    const retriever = new VectorRetriever({
      db: context.db,
      embeddingProvider: provider,
    });

    const fromA = await context.repository.create(createMemoryInput("From provider A"));
    const fromB = await context.repository.create(createMemoryInput("From provider B"));
    expect(fromA.ok).toBe(true);
    expect(fromB.ok).toBe(true);
    if (!fromA.ok || !fromB.ok) {
      return;
    }

    insertEmbedding(context.db, {
      memoryId: fromA.value.id,
      provider: "provider-a",
      model: "shared-model",
      dimension: 3,
      vector: new Float32Array([1, 0, 0]),
    });
    insertEmbedding(context.db, {
      memoryId: fromB.value.id,
      provider: "provider-b",
      model: "shared-model",
      dimension: 3,
      vector: new Float32Array([1, 0, 0]),
    });

    const defaultResult = await retriever.search("provider query");
    expect(defaultResult.ok).toBe(true);
    if (defaultResult.ok) {
      expect(defaultResult.value.length).toBe(1);
      expect(defaultResult.value[0]?.memoryId).toBe(fromA.value.id);
    }

    const filteredResult = await retriever.search("provider query", {
      providerFilter: "provider-b",
    });
    expect(filteredResult.ok).toBe(true);
    if (filteredResult.ok) {
      expect(filteredResult.value.length).toBe(1);
      expect(filteredResult.value[0]?.memoryId).toBe(fromB.value.id);
    }
  });

  test("returns explicit error on dimension mismatch", async () => {
    const context = await createTestContext("vector-dimension-mismatch-");
    const provider = new MockEmbeddingProvider({
      id: "mock-provider",
      model: "mock-model",
      dimension: 3,
      embeddings: {
        "dimension query": new Float32Array([1, 0, 0]),
      },
    });

    const retriever = new VectorRetriever({
      db: context.db,
      embeddingProvider: provider,
    });

    const created = await context.repository.create(createMemoryInput("Mismatched dimension record"));
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    insertEmbedding(context.db, {
      memoryId: created.value.id,
      provider: "mock-provider",
      model: "mock-model",
      dimension: 4,
      vector: new Float32Array([1, 0, 0, 0]),
    });

    const result = await retriever.search("dimension query");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VECTOR_RETRIEVER_DIMENSION_MISMATCH");
      expect(result.error.message).toContain("Dimension mismatch");
      expect(result.error.message).toContain("query dimension 3");
      expect(result.error.message).toContain("stored dimension 4");
    }
  });

  test("returns empty result when no vectors match", async () => {
    const context = await createTestContext("vector-empty-");
    const provider = new MockEmbeddingProvider({
      id: "mock-provider",
      model: "mock-model",
      dimension: 3,
      embeddings: {
        "empty query": new Float32Array([1, 0, 0]),
      },
    });

    const retriever = new VectorRetriever({
      db: context.db,
      embeddingProvider: provider,
    });

    const result = await retriever.search("empty query");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("integration: store embeddings and retrieve by semantic similarity", async () => {
    const context = await createTestContext("vector-integration-");
    const provider = new MockEmbeddingProvider({
      id: "integration-provider",
      model: "integration-model",
      dimension: 3,
      embeddings: {
        "bun runtime": new Float32Array([1, 0, 0]),
      },
    });

    const retriever = new VectorRetriever({
      db: context.db,
      embeddingProvider: provider,
    });

    const bunMemory = await context.repository.create(createMemoryInput("Bun is a fast JavaScript runtime."));
    const sqliteMemory = await context.repository.create(createMemoryInput("SQLite uses B-tree indexes."));
    expect(bunMemory.ok).toBe(true);
    expect(sqliteMemory.ok).toBe(true);
    if (!bunMemory.ok || !sqliteMemory.ok) {
      return;
    }

    insertEmbedding(context.db, {
      memoryId: bunMemory.value.id,
      provider: "integration-provider",
      model: "integration-model",
      dimension: 3,
      vector: new Float32Array([0.99, 0.01, 0]),
    });
    insertEmbedding(context.db, {
      memoryId: sqliteMemory.value.id,
      provider: "integration-provider",
      model: "integration-model",
      dimension: 3,
      vector: new Float32Array([0.1, 0.95, 0]),
    });

    const result = await retriever.search("bun runtime", { limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBe(1);
    expect(result.value[0]?.memoryId).toBe(bunMemory.value.id);
    expect(result.value[0]?.content).toContain("Bun");
  });
});
