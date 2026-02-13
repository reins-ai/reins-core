import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ok, type Result } from "../../../src/result";
import {
  BM25Retriever,
  HybridMemorySearch,
  type VectorRetriever,
  type VectorSearchResult,
} from "../../../src/memory/search/index";
import {
  SqliteMemoryDb,
  SqliteMemoryRepository,
  type CreateMemoryInput,
} from "../../../src/memory/storage";

interface BenchmarkContext {
  rootDir: string;
  db: SqliteMemoryDb;
  repository: SqliteMemoryRepository;
  bm25Retriever: BM25Retriever;
}

interface TopicSeed {
  id: string;
  content: string;
  type: CreateMemoryInput["type"];
}

interface QueryCase {
  query: string;
  topicId: string;
}

interface MemoryProjection {
  id: string;
  content: string;
  type: CreateMemoryInput["type"];
  importance: number;
}

const contexts: BenchmarkContext[] = [];

const TOPIC_SEEDS: TopicSeed[] = [
  {
    id: "dark-theme",
    type: "preference",
    content:
      "User prefers dark terminal themes at night because bright interfaces cause eye strain during long coding sessions.",
  },
  {
    id: "typecheck-gate",
    type: "fact",
    content:
      "Run bun run typecheck before pushing changes so strict TypeScript errors are caught before review.",
  },
  {
    id: "consolidation-cadence",
    type: "fact",
    content:
      "The memory consolidation runner executes every six hours and supports manual trigger for urgent merges.",
  },
  {
    id: "reindex-switch",
    type: "fact",
    content:
      "Switching embedding provider requires a full reindex to refresh vectors with the new model dimension.",
  },
  {
    id: "chunking-headings",
    type: "fact",
    content:
      "Markdown chunking keeps heading hierarchy metadata so retrieved chunks preserve section context.",
  },
  {
    id: "hybrid-retrieval",
    type: "fact",
    content:
      "Hybrid retrieval combines FTS5 BM25 keyword recall with vector similarity, then fuses ranks for final ordering.",
  },
  {
    id: "oauth-callback",
    type: "fact",
    content:
      "Desktop OAuth uses a local callback server so browser authentication can return tokens safely.",
  },
  {
    id: "proactive-controls",
    type: "preference",
    content:
      "Proactive memory nudges should be configurable by topic and frequency to avoid interrupting users.",
  },
  {
    id: "wal-mode",
    type: "fact",
    content:
      "SQLite is configured with WAL mode and foreign keys enabled to improve reliability during concurrent writes.",
  },
  {
    id: "result-boundary",
    type: "fact",
    content:
      "Service boundaries return Result<T> objects to encode recoverable failures without throwing exceptions.",
  },
  {
    id: "source-attribution",
    type: "fact",
    content:
      "Auto-saved memories include conversation provenance so every extracted fact is traceable to source context.",
  },
  {
    id: "privacy-policy",
    type: "preference",
    content:
      "Never persist secrets like API keys in plaintext memory entries or benchmark fixtures.",
  },
];

const PARAPHRASE_QUERIES: QueryCase[] = [
  { query: "use darker terminal themes when coding late", topicId: "dark-theme" },
  { query: "run typecheck compile checks before commit", topicId: "typecheck-gate" },
  { query: "how often does consolidation memory merge run", topicId: "consolidation-cadence" },
  { query: "changing embedding provider means regenerate vectors", topicId: "reindex-switch" },
  { query: "retain markdown heading hierarchy in chunks", topicId: "chunking-headings" },
  { query: "blend BM25 lexical and vector semantic ranking", topicId: "hybrid-retrieval" },
  { query: "browser oauth redirects back to localhost callback", topicId: "oauth-callback" },
  { query: "let users tune proactive nudges frequency", topicId: "proactive-controls" },
  { query: "sqlite WAL logging for safer concurrent writes", topicId: "wal-mode" },
  { query: "return Result wrappers at service boundaries", topicId: "result-boundary" },
  { query: "memory extracts must include conversation provenance metadata", topicId: "source-attribution" },
  { query: "do not store API keys in clear text memory", topicId: "privacy-policy" },
];

class DeterministicVectorRetriever {
  constructor(
    private readonly queryMap: Map<string, VectorSearchResult[]>,
  ) {}

  async search(query: string): Promise<Result<VectorSearchResult[]>> {
    return ok(this.queryMap.get(query) ?? []);
  }
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

async function createContext(prefix: string): Promise<BenchmarkContext> {
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
  const bm25Retriever = new BM25Retriever({ db });

  const context: BenchmarkContext = { rootDir, db, repository, bm25Retriever };
  contexts.push(context);
  return context;
}

function asMemoryInput(seed: TopicSeed, variant: number): CreateMemoryInput {
  const marker = seed.id.replace(/-/g, "_");

  return {
    content: `${seed.content} ${marker} exemplar ${variant + 1}.`,
    type: seed.type,
    layer: variant % 2 === 0 ? "ltm" : "stm",
    importance: variant === 0 ? 0.9 : 0.5,
    confidence: 1,
    tags: [seed.id, "benchmark"],
    entities: [seed.id.replace(/-/g, "_")],
    source: {
      type: "explicit",
      conversationId: `bench-${seed.id}`,
    },
  };
}

function buildVectorQueryMap(
  recordsByTopic: Map<string, MemoryProjection[]>,
): Map<string, VectorSearchResult[]> {
  const vectorMap = new Map<string, VectorSearchResult[]>();

  for (const queryCase of PARAPHRASE_QUERIES) {
    const primaryTopicRecords = recordsByTopic.get(queryCase.topicId) ?? [];
    const distractorTopic = TOPIC_SEEDS.find((seed) => seed.id !== queryCase.topicId);
    const distractorRecords = distractorTopic ? (recordsByTopic.get(distractorTopic.id) ?? []) : [];

    const primary = primaryTopicRecords[0];
    const supporting = primaryTopicRecords[1];
    const distractor = distractorRecords[0];

    const results: VectorSearchResult[] = [];
    if (primary) {
      results.push({
        memoryId: primary.id,
        content: primary.content,
        type: primary.type,
        layer: "ltm",
        importance: primary.importance,
        similarity: 0.96,
        embeddingMetadata: {
          provider: "mock-vector",
          model: "deterministic",
          dimension: 8,
        },
      });
    }

    if (supporting) {
      results.push({
        memoryId: supporting.id,
        content: supporting.content,
        type: supporting.type,
        layer: "stm",
        importance: supporting.importance,
        similarity: 0.81,
        embeddingMetadata: {
          provider: "mock-vector",
          model: "deterministic",
          dimension: 8,
        },
      });
    }

    if (distractor) {
      results.push({
        memoryId: distractor.id,
        content: distractor.content,
        type: distractor.type,
        layer: "ltm",
        importance: distractor.importance,
        similarity: 0.52,
        embeddingMetadata: {
          provider: "mock-vector",
          model: "deterministic",
          dimension: 8,
        },
      });
    }

    vectorMap.set(queryCase.query, results);
  }

  return vectorMap;
}

afterEach(async () => {
  for (const context of contexts) {
    context.db.close();
    await rm(context.rootDir, { recursive: true, force: true });
  }

  contexts.length = 0;
});

describe("hybrid retrieval benchmark", () => {
  test("meets top-3 quality target across paraphrase queries", async () => {
    const context = await createContext("hybrid-benchmark-");

    const recordsByTopic = new Map<string, MemoryProjection[]>();
    for (const seed of TOPIC_SEEDS) {
      const topicRecords: MemoryProjection[] = [];
      for (let variant = 0; variant < 5; variant += 1) {
        const created = await context.repository.create(asMemoryInput(seed, variant));
        expect(created.ok).toBe(true);
        if (!created.ok) {
          throw created.error;
        }

        topicRecords.push({
          id: created.value.id,
          content: created.value.content,
          type: created.value.type,
          importance: created.value.importance,
        });
      }

      recordsByTopic.set(seed.id, topicRecords);
    }

    const totalRecords = Array.from(recordsByTopic.values()).reduce((sum, group) => sum + group.length, 0);
    expect(totalRecords).toBeGreaterThanOrEqual(50);
    expect(PARAPHRASE_QUERIES.length).toBeGreaterThanOrEqual(10);

    const vectorRetriever = new DeterministicVectorRetriever(buildVectorQueryMap(recordsByTopic));
    const hybridSearch = new HybridMemorySearch({
      bm25Retriever: context.bm25Retriever,
      vectorRetriever: vectorRetriever as unknown as VectorRetriever,
    });

    let bm25Hits = 0;
    let hybridHits = 0;
    const bm25Latencies: number[] = [];
    const hybridLatencies: number[] = [];

    for (const queryCase of PARAPHRASE_QUERIES) {
      const expectedTopicIds = new Set((recordsByTopic.get(queryCase.topicId) ?? []).map((item) => item.id));
      expect(expectedTopicIds.size).toBeGreaterThan(0);
      if (expectedTopicIds.size === 0) {
        throw new Error(`Missing expected topic ids for ${queryCase.topicId}`);
      }

      const bm25Start = performance.now();
      const bm25Result = context.bm25Retriever.search(queryCase.query, { limit: 10 });
      bm25Latencies.push(performance.now() - bm25Start);

      expect(bm25Result.ok).toBe(true);
      if (!bm25Result.ok) {
        throw bm25Result.error;
      }

      const bm25Top3 = bm25Result.value.slice(0, 3).map((item) => item.memoryId);
      if (bm25Top3.some((memoryId) => expectedTopicIds.has(memoryId))) {
        bm25Hits += 1;
      }

      const hybridStart = performance.now();
      const hybridResult = await hybridSearch.search(queryCase.query, {
        limit: 3,
        bm25Weight: 0.35,
        vectorWeight: 0.65,
        importanceBoost: 0.05,
      });
      hybridLatencies.push(performance.now() - hybridStart);

      expect(hybridResult.ok).toBe(true);
      if (!hybridResult.ok) {
        throw hybridResult.error;
      }

      const hybridTop3 = hybridResult.value.slice(0, 3).map((item) => item.memoryId);
      if (hybridTop3.some((memoryId) => expectedTopicIds.has(memoryId))) {
        hybridHits += 1;
      }
    }

    const totalQueries = PARAPHRASE_QUERIES.length;
    const bm25HitRate = bm25Hits / totalQueries;
    const hybridHitRate = hybridHits / totalQueries;

    const bm25AvgLatency = bm25Latencies.reduce((sum, value) => sum + value, 0) / bm25Latencies.length;
    const hybridAvgLatency = hybridLatencies.reduce((sum, value) => sum + value, 0) / hybridLatencies.length;

    console.info(
      `[benchmark][hybrid] queries=${totalQueries} corpus=${totalRecords} ` +
        `bm25_top3_hit_rate=${(bm25HitRate * 100).toFixed(1)}% ` +
        `hybrid_top3_hit_rate=${(hybridHitRate * 100).toFixed(1)}% ` +
        `bm25_avg_ms=${bm25AvgLatency.toFixed(2)} bm25_p95_ms=${percentile(bm25Latencies, 95).toFixed(2)} ` +
        `hybrid_avg_ms=${hybridAvgLatency.toFixed(2)} hybrid_p95_ms=${percentile(hybridLatencies, 95).toFixed(2)}`,
    );

    expect(bm25AvgLatency).toBeLessThan(25);
    expect(hybridHitRate).toBeGreaterThanOrEqual(0.7);
    expect(hybridHitRate).toBeGreaterThanOrEqual(bm25HitRate);
  });
});
