import { describe, expect, test } from "bun:test";

import { ok, type Result } from "../../../src/result";
import { MarkdownChunker, type DocumentChunk } from "../../../src/memory/rag/markdown-chunker";
import {
  UnifiedMemoryRetrieval,
  type DocumentSearchProvider,
  type DocumentSearchResult,
  type MemorySearchProvider,
  type MemorySearchResult,
} from "../../../src/memory/search/unified-memory-retrieval";

interface QueryExpectation {
  query: string;
  expectedChunkId: string;
}

const DOCUMENTS = [
  {
    sourceId: "ops-guide",
    sourcePath: "/docs/ops/memory-operations.md",
    markdown: `# Memory Operations

## Reindex Workflow
Switching the embedding provider requires a full reindex. Run the reindex command and wait for completion checkpoints.

## Consolidation Schedule
The consolidation pipeline runs every six hours and can be triggered manually for incident response.

## Safety Rules
Never write API keys to memory files or logs.
`,
  },
  {
    sourceId: "retrieval-design",
    sourcePath: "/docs/architecture/retrieval-design.md",
    markdown: `# Retrieval Design

## Hybrid Ranking
Hybrid ranking fuses BM25 lexical scores with vector similarity to improve recall for paraphrased queries.

## Explainability
Result payloads should include score breakdown, source metadata, and rank position.
`,
  },
  {
    sourceId: "chunking-guide",
    sourcePath: "/docs/architecture/chunking-guide.md",
    markdown: `# Chunking Guide

## Heading Aware Strategy
Markdown chunking preserves heading hierarchy so context is retained across section boundaries.

## Overlap Strategy
Add overlap between adjacent chunks to protect continuity when a sentence crosses chunk boundaries.
`,
  },
  {
    sourceId: "runbook",
    sourcePath: "/docs/runbook/incident-response.md",
    markdown: `# Incident Runbook

## Retrieval Diagnostics
Measure p95 retrieval latency and track top-3 relevance hit rate in benchmark suites.

## Recovery
If indexing fails, retry with reduced concurrency and inspect per-file error logs.
`,
  },
];

class DeterministicMemoryProvider implements MemorySearchProvider {
  async search(): Promise<Result<MemorySearchResult[]>> {
    return ok([
      {
        id: "memory-note-1",
        content: "General note unrelated to document retrieval benchmarks.",
        score: 0.12,
        type: "fact",
        layer: "stm",
        importance: 0.3,
        tags: ["benchmark"],
      },
    ]);
  }
}

class ChunkDocumentSearchProvider implements DocumentSearchProvider {
  constructor(private readonly chunks: DocumentChunk[]) {}

  async search(
    query: string,
    topK: number,
    filters?: { sourceIds?: string[] },
  ): Promise<Result<DocumentSearchResult[]>> {
    const queryTerms = tokenize(query);
    const sourceFilter = new Set(filters?.sourceIds ?? []);

    const scored = this.chunks
      .filter((chunk) => sourceFilter.size === 0 || sourceFilter.has(chunk.sourceId))
      .map((chunk) => {
        const content = chunk.content.toLowerCase();
        let overlapHits = 0;
        for (const term of queryTerms) {
          if (content.includes(term)) {
            overlapHits += 1;
          }
        }

        const overlapScore = queryTerms.length === 0 ? 0 : overlapHits / queryTerms.length;
        const phraseBonus = content.includes(query.toLowerCase()) ? 0.3 : 0;
        const score = Math.min(1, overlapScore + phraseBonus);

        return {
          chunk,
          score,
        };
      })
      .filter((item) => item.score > 0)
      .sort((left, right) => {
        if (right.score !== left.score) {
          return right.score - left.score;
        }

        return left.chunk.id.localeCompare(right.chunk.id);
      })
      .slice(0, topK)
      .map((item): DocumentSearchResult => ({
        chunkId: item.chunk.id,
        content: item.chunk.content,
        score: item.score,
        sourcePath: item.chunk.sourcePath,
        heading: item.chunk.heading,
        headingHierarchy: item.chunk.headingHierarchy,
        sourceId: item.chunk.sourceId,
        chunkIndex: item.chunk.chunkIndex,
      }));

    return ok(scored);
  }
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

function collectChunks(): DocumentChunk[] {
  const chunker = new MarkdownChunker({
    strategy: "heading",
    maxChunkSize: 280,
    minChunkSize: 40,
    overlapSize: 20,
  });

  const chunks: DocumentChunk[] = [];
  for (const document of DOCUMENTS) {
    const chunkResult = chunker.chunk(document.markdown, document.sourcePath, document.sourceId);
    expect(chunkResult.ok).toBe(true);
    if (!chunkResult.ok) {
      throw chunkResult.error;
    }

    chunks.push(...chunkResult.value);
  }

  return chunks;
}

function findChunkIdByPhrase(chunks: DocumentChunk[], phrase: string): string {
  const lowered = phrase.toLowerCase();
  const match = chunks.find((chunk) => chunk.content.toLowerCase().includes(lowered));
  expect(match).toBeDefined();
  if (!match) {
    throw new Error(`No chunk matched phrase: ${phrase}`);
  }

  return match.id;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

describe("RAG retrieval benchmark", () => {
  test("returns relevant indexed document chunks in unified results with throughput metrics", async () => {
    const chunks = collectChunks();
    expect(chunks.length).toBeGreaterThan(8);

    const expectations: QueryExpectation[] = [
      {
        query: "why do we need full reindex after embedding provider change",
        expectedChunkId: findChunkIdByPhrase(chunks, "full reindex"),
      },
      {
        query: "how often does consolidation run",
        expectedChunkId: findChunkIdByPhrase(chunks, "runs every six hours"),
      },
      {
        query: "combine bm25 with vector semantic scores",
        expectedChunkId: findChunkIdByPhrase(chunks, "fuses BM25 lexical scores with vector similarity"),
      },
      {
        query: "preserve heading hierarchy during markdown chunking",
        expectedChunkId: findChunkIdByPhrase(chunks, "preserves heading hierarchy"),
      },
      {
        query: "track p95 latency and top three relevance",
        expectedChunkId: findChunkIdByPhrase(chunks, "p95 retrieval latency and track top-3 relevance"),
      },
      {
        query: "keep secrets out of memory logs",
        expectedChunkId: findChunkIdByPhrase(chunks, "Never write API keys to memory files or logs"),
      },
    ];

    const retrieval = new UnifiedMemoryRetrieval({
      memorySearch: new DeterministicMemoryProvider(),
      documentSearch: new ChunkDocumentSearchProvider(chunks),
      config: {
        memoryWeight: 0.2,
        documentWeight: 0.8,
      },
    });

    let hits = 0;
    const latencies: number[] = [];

    for (const scenario of expectations) {
      const startedAt = performance.now();
      const result = await retrieval.search({
        query: scenario.query,
        topK: 3,
        minScore: 0.05,
      });
      latencies.push(performance.now() - startedAt);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw result.error;
      }

      const documentTop3 = result.value
        .filter((item) => item.source === "document")
        .slice(0, 3)
        .map((item) => item.id);

      if (documentTop3.includes(scenario.expectedChunkId)) {
        hits += 1;
      }
    }

    const hitRate = hits / expectations.length;

    const throughputRuns = 80;
    const throughputStart = performance.now();
    let executedQueries = 0;
    for (let run = 0; run < throughputRuns; run += 1) {
      const scenario = expectations[run % expectations.length];
      const result = await retrieval.search({
        query: scenario.query,
        topK: 3,
        minScore: 0.05,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw result.error;
      }

      executedQueries += 1;
    }

    const elapsedSeconds = Math.max((performance.now() - throughputStart) / 1000, 0.001);
    const throughputQps = executedQueries / elapsedSeconds;
    const averageLatency = latencies.reduce((sum, value) => sum + value, 0) / latencies.length;

    console.info(
      `[benchmark][rag] scenarios=${expectations.length} chunks=${chunks.length} ` +
        `top3_hit_rate=${(hitRate * 100).toFixed(1)}% avg_ms=${averageLatency.toFixed(2)} ` +
        `p95_ms=${percentile(latencies, 95).toFixed(2)} throughput_qps=${throughputQps.toFixed(1)}`,
    );

    expect(hitRate).toBeGreaterThanOrEqual(0.8);
    expect(throughputQps).toBeGreaterThan(20);
  });
});
