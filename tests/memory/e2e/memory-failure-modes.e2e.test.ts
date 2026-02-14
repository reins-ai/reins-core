import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConsolidationRunner,
  DistillationEngine,
  ImportanceScorer,
  MergeEngine,
  SimpleMemoryLookup,
  StmSelector,
  type LtmWriter,
} from "../../../src/memory/consolidation";
import {
  createMemoryErrorFromCode,
  errFromMemoryCode,
  getMemoryErrorMetadata,
} from "../../../src/memory/errors/memory-error-codes";
import {
  type EmbeddingProvider,
  EmbeddingProviderError,
  ReindexService,
  SqliteEmbeddingReindexStorage,
  vectorToBlob,
} from "../../../src/memory/embeddings";
import { parse } from "../../../src/memory/io/markdown-memory-codec";
import { MemoryFileIngestor } from "../../../src/memory/io/memory-file-ingestor";
import {
  BM25Retriever,
  HybridMemorySearch,
  VectorRetriever,
} from "../../../src/memory/search/index";
import {
  SqliteMemoryDb,
  SqliteMemoryRepository,
  type CreateMemoryInput,
} from "../../../src/memory/storage";
import type { MemoryRecord } from "../../../src/memory/types";
import { err, ok } from "../../../src/result";

interface TestContext {
  rootDir: string;
  db: SqliteMemoryDb;
  repository: SqliteMemoryRepository;
  dataDir: string;
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

  async embed(text: string) {
    if (this.failWhenIncludes && text.toLowerCase().includes(this.failWhenIncludes)) {
      return err(
        new EmbeddingProviderError(
          `Provider unavailable for '${text}'`,
          "MEMORY_PROVIDER_UNAVAILABLE",
        ),
      );
    }

    const normalized = text.toLowerCase();
    const vector = new Float32Array([
      normalized.includes("typescript") ? 1 : 0,
      normalized.includes("database") ? 1 : 0,
      normalized.includes("rollback") ? 1 : 0,
      Math.min(1, text.length / 100),
    ]);
    return ok(vector);
  }

  async embedBatch(texts: string[]) {
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

  async isAvailable() {
    return this.failWhenIncludes === null;
  }
}

class CountingFailingProvider implements EmbeddingProvider {
  readonly id = "circuit-provider";
  readonly model = "circuit-model";
  readonly dimension = 4;
  readonly version = "1";

  calls = 0;

  async embed(_text: string) {
    this.calls += 1;
    return err(
      new EmbeddingProviderError(
        "Provider offline",
        "MEMORY_PROVIDER_UNAVAILABLE",
      ),
    );
  }

  async embedBatch(texts: string[]) {
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

  async isAvailable() {
    return false;
  }
}

class CircuitBreakerEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimension: number;
  readonly version: string;

  private readonly delegate: EmbeddingProvider;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private consecutiveFailures = 0;
  private openUntil = 0;

  constructor(options: {
    delegate: EmbeddingProvider;
    failureThreshold: number;
    cooldownMs: number;
    now: () => number;
  }) {
    this.delegate = options.delegate;
    this.failureThreshold = options.failureThreshold;
    this.cooldownMs = options.cooldownMs;
    this.now = options.now;
    this.id = options.delegate.id;
    this.model = options.delegate.model;
    this.dimension = options.delegate.dimension;
    this.version = options.delegate.version;
  }

  async embed(text: string) {
    if (this.now() < this.openUntil) {
      return err(
        new EmbeddingProviderError(
          "Provider circuit breaker is open",
          "MEMORY_PROVIDER_UNAVAILABLE",
        ),
      );
    }

    const embedded = await this.delegate.embed(text);
    if (embedded.ok) {
      this.consecutiveFailures = 0;
      return embedded;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openUntil = this.now() + this.cooldownMs;
    }

    return embedded;
  }

  async embedBatch(texts: string[]) {
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

  async isAvailable() {
    return this.now() >= this.openUntil;
  }
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
      conversationId: "conv-failure-modes",
    },
  };
}

function makeStmRecord(id: string, content: string): MemoryRecord {
  const now = new Date("2026-02-13T12:00:00.000Z");
  const createdAt = new Date(now.getTime() - 10 * 60 * 1_000);

  return {
    id,
    content,
    type: "fact",
    layer: "stm",
    tags: ["failure-mode"],
    entities: [],
    importance: 0.6,
    confidence: 0.8,
    provenance: {
      sourceType: "implicit",
      conversationId: "conv-distillation",
    },
    createdAt,
    updatedAt: createdAt,
    accessedAt: createdAt,
  };
}

async function createContext(prefix: string): Promise<TestContext> {
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
  const context: TestContext = { rootDir, db, repository, dataDir };
  contexts.push(context);
  return context;
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

describe("Memory failure modes E2E", () => {
  test("degrades to BM25 when embedding provider is unavailable", async () => {
    const context = await createContext("memory-failure-hybrid-");
    const created = await context.repository.create(
      memoryInput("TypeScript deployment playbook for staging rollback"),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const bm25Retriever = new BM25Retriever({ db: context.db });
    const failingProvider = new KeywordEmbeddingProvider({
      id: "provider-a",
      model: "model-a",
      failWhenIncludes: "typescript",
    });
    const vectorRetriever = new VectorRetriever({
      db: context.db,
      embeddingProvider: failingProvider,
    });

    const hybrid = new HybridMemorySearch({ bm25Retriever, vectorRetriever });
    const result = await hybrid.search("TypeScript rollback", { limit: 5 });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.length).toBeGreaterThan(0);
    expect(result.value[0].content).toContain("TypeScript");
    expect(result.value[0].breakdown.vectorScore).toBe(0);
  });

  test("handles malformed distillation output without crashing consolidation run", async () => {
    const sourceRecord = makeStmRecord(
      "stm-failure-1",
      "Team decided to use Bun for memory workflows.",
    );

    const selector = new StmSelector({
      source: {
        async listStmRecords() {
          return ok([sourceRecord]);
        },
      },
      now: () => new Date("2026-02-13T12:00:00.000Z"),
      generateId: () => "batch-failure-1",
    });

    const distillationEngine = new DistillationEngine({
      provider: async () => "not-json",
    });

    const mergeEngine = new MergeEngine({
      lookup: new SimpleMemoryLookup(),
      scorer: new ImportanceScorer(),
      config: {
        generateId: () => randomUUID(),
      },
    });

    const ltmWriter: LtmWriter = {
      async getExisting() {
        return ok([]);
      },
      async write() {
        return ok(undefined);
      },
    };

    const runner = new ConsolidationRunner({
      selector,
      distillationEngine,
      mergeEngine,
      ltmWriter,
      config: {
        now: () => new Date("2026-02-13T12:00:00.000Z"),
        generateRunId: () => "run-failure-1",
      },
    });

    const result = await runner.run();
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.stats.candidatesProcessed).toBe(1);
    expect(result.value.stats.factsDistilled).toBe(0);
    expect(result.value.errors.some((entry) => entry.includes("parse"))).toBe(true);

    const candidate = selector.getCandidateStatus(sourceRecord.id);
    expect(candidate?.status).toBe("failed");
    expect(candidate?.retryCount).toBe(1);
  });

  test("returns Result error when repository write path fails", async () => {
    const context = await createContext("memory-failure-write-");
    const blockedPath = join(context.rootDir, "blocked-path");
    await writeFile(blockedPath, "not a directory", "utf8");

    const brokenRepository = new SqliteMemoryRepository({
      db: context.db,
      dataDir: blockedPath,
    });

    const result = await brokenRepository.create(memoryInput("Write failure test"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(["MEMORY_REPOSITORY_DB_ERROR", "MEMORY_REPOSITORY_IO_ERROR"]).toContain(
        result.error.code,
      );
    }
  });

  test("quarantines malformed memory markdown with warning", async () => {
    const context = await createContext("memory-failure-ingest-");
    const ingestDir = join(context.rootDir, "incoming");
    const quarantineDir = join(context.rootDir, "quarantine");
    await mkdir(ingestDir, { recursive: true });

    const malformedPath = join(ingestDir, "malformed.md");
    await writeFile(malformedPath, "this is not valid frontmatter", "utf8");

    const warnings: string[] = [];
    const ingestor = new MemoryFileIngestor({
      repository: context.repository,
      codec: {
        parse(markdown: string) {
          return parse(markdown);
        },
      },
      quarantineDir,
      logger: {
        warn(message) {
          warnings.push(message);
        },
        info() {
          // no-op for this test
        },
        error() {
          // no-op for this test
        },
      },
    });

    const report = await ingestor.scanDirectory(ingestDir);
    expect(report.ok).toBe(true);
    if (!report.ok) {
      return;
    }

    expect(report.value.quarantined).toBe(1);
    expect(report.value.errors).toHaveLength(0);

    const quarantinedFiles = await readdir(quarantineDir);
    expect(quarantinedFiles.includes("malformed.md")).toBe(true);
    expect(quarantinedFiles.includes("malformed.md.error")).toBe(true);
    expect(warnings.some((message) => message.includes("Quarantined invalid file"))).toBe(true);
  });

  test("supports partial reindex recovery after interruption", async () => {
    const context = await createContext("memory-failure-reindex-");
    const oldProvider = new KeywordEmbeddingProvider({
      id: "provider-old",
      model: "embeddings-old",
    });

    const flakyProvider = new KeywordEmbeddingProvider({
      id: "provider-new",
      model: "embeddings-new",
      failWhenIncludes: "rollback",
    });

    const healthyProvider = new KeywordEmbeddingProvider({
      id: "provider-new",
      model: "embeddings-new",
    });

    const firstMemory = await context.repository.create(
      memoryInput("TypeScript architecture notes"),
    );
    const secondMemory = await context.repository.create(
      memoryInput("Rollback runbook for production deploy"),
    );
    expect(firstMemory.ok).toBe(true);
    expect(secondMemory.ok).toBe(true);
    if (!firstMemory.ok || !secondMemory.ok) {
      return;
    }

    const oldFirst = await oldProvider.embed(firstMemory.value.content);
    const oldSecond = await oldProvider.embed(secondMemory.value.content);
    expect(oldFirst.ok).toBe(true);
    expect(oldSecond.ok).toBe(true);
    if (!oldFirst.ok || !oldSecond.ok) {
      return;
    }

    insertEmbedding(context.db, firstMemory.value.id, oldProvider, oldFirst.value);
    insertEmbedding(context.db, secondMemory.value.id, oldProvider, oldSecond.value);

    const firstRun = await new ReindexService({
      storage: new SqliteEmbeddingReindexStorage({ db: context.db }),
      oldProvider: {
        provider: oldProvider.id,
        model: oldProvider.model,
      },
      newProvider: flakyProvider,
    }).reindex({
      validateAfterReindex: false,
      batchSize: 2,
    });

    expect(firstRun.ok).toBe(true);
    if (!firstRun.ok) {
      return;
    }

    expect(firstRun.value.reindexed).toBe(1);
    expect(firstRun.value.failed).toBe(1);

    const secondRun = await new ReindexService({
      storage: new SqliteEmbeddingReindexStorage({ db: context.db }),
      oldProvider: {
        provider: oldProvider.id,
        model: oldProvider.model,
      },
      newProvider: healthyProvider,
    }).reindex({
      validateAfterReindex: false,
      batchSize: 2,
    });

    expect(secondRun.ok).toBe(true);
    if (!secondRun.ok) {
      return;
    }

    expect(secondRun.value.totalRecords).toBe(1);
    expect(secondRun.value.reindexed).toBe(1);
    expect(secondRun.value.failed).toBe(0);
  });

  test("opens circuit breaker after repeated provider failures", async () => {
    let currentTime = 1_000;
    const failing = new CountingFailingProvider();
    const breaker = new CircuitBreakerEmbeddingProvider({
      delegate: failing,
      failureThreshold: 2,
      cooldownMs: 60_000,
      now: () => currentTime,
    });

    const first = await breaker.embed("first");
    const second = await breaker.embed("second");
    const third = await breaker.embed("third");

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    expect(third.ok).toBe(false);
    expect(failing.calls).toBe(2);

    currentTime += 61_000;
    const afterCooldown = await breaker.embed("after-cooldown");
    expect(afterCooldown.ok).toBe(false);
    expect(failing.calls).toBe(3);
  });

  test("exposes typed memory error codes at Result boundaries", () => {
    const recoverable = errFromMemoryCode<void>("MEMORY_PROVIDER_UNAVAILABLE");
    expect(recoverable.ok).toBe(false);
    if (!recoverable.ok) {
      expect(recoverable.error.code).toBe("MEMORY_PROVIDER_UNAVAILABLE");
      expect(getMemoryErrorMetadata("MEMORY_PROVIDER_UNAVAILABLE").severity).toBe("recoverable");
    }

    const fatal = createMemoryErrorFromCode("MEMORY_STORAGE_WRITE_FAILED");
    expect(fatal.code).toBe("MEMORY_STORAGE_WRITE_FAILED");
    expect(getMemoryErrorMetadata("MEMORY_STORAGE_WRITE_FAILED").severity).toBe("fatal");
  });
});
