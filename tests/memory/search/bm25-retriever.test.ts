import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BM25Retriever,
  normalizeBM25Scores,
  type BM25SearchResult,
} from "../../../src/memory/search/index";
import { parseSearchQuery } from "../../../src/memory/search/search-query-parser";
import {
  SqliteMemoryDb,
  SqliteMemoryRepository,
  type CreateMemoryInput,
} from "../../../src/memory/storage/index";
import type { MemoryLayer, MemorySourceType, MemoryType } from "../../../src/memory/types/index";

interface TestContext {
  rootDir: string;
  dataDir: string;
  memoryDb: SqliteMemoryDb;
  repository: SqliteMemoryRepository;
  retriever: BM25Retriever;
}

const contexts: TestContext[] = [];

async function createTestContext(prefix: string): Promise<TestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const dbPath = join(rootDir, "memory.db");
  const dataDir = join(rootDir, "memory-files");

  await mkdir(dataDir, { recursive: true });

  const memoryDb = new SqliteMemoryDb({ dbPath });
  const initResult = memoryDb.initialize();
  expect(initResult.ok).toBe(true);
  if (!initResult.ok) {
    throw initResult.error;
  }

  const repository = new SqliteMemoryRepository({
    db: memoryDb,
    dataDir,
  });

  const retriever = new BM25Retriever({ db: memoryDb });

  const context: TestContext = {
    rootDir,
    dataDir,
    memoryDb,
    repository,
    retriever,
  };

  contexts.push(context);
  return context;
}

function createInput(overrides?: Partial<CreateMemoryInput>): CreateMemoryInput {
  return {
    content: "Default test memory content.",
    type: "fact",
    layer: "stm",
    importance: 0.5,
    confidence: 1.0,
    tags: [],
    entities: [],
    source: {
      type: "explicit",
      conversationId: "conv_test",
    },
    ...overrides,
  };
}

afterEach(async () => {
  for (const ctx of contexts) {
    ctx.memoryDb.close();
    await rm(ctx.rootDir, { recursive: true, force: true });
  }
  contexts.length = 0;
});

describe("parseSearchQuery", () => {
  test("returns empty string for empty input", () => {
    expect(parseSearchQuery("")).toBe("");
    expect(parseSearchQuery("   ")).toBe("");
  });

  test("passes through simple terms", () => {
    expect(parseSearchQuery("hello world")).toBe("hello world");
  });

  test("preserves quoted phrases", () => {
    const result = parseSearchQuery('"exact phrase" other');
    expect(result).toContain('"exact phrase"');
    expect(result).toContain("other");
  });

  test("preserves prefix matching with asterisk", () => {
    expect(parseSearchQuery("type*")).toBe("type*");
    expect(parseSearchQuery("hello* world")).toBe("hello* world");
  });

  test("strips FTS5 operators from input", () => {
    const result = parseSearchQuery("hello AND world OR test NOT bad");
    expect(result).not.toContain("AND");
    expect(result).not.toContain("OR");
    expect(result).not.toContain("NOT");
  });

  test("strips unsafe characters", () => {
    const result = parseSearchQuery("hello{world} (test) [bracket]");
    expect(result).not.toContain("{");
    expect(result).not.toContain("}");
    expect(result).not.toContain("(");
    expect(result).not.toContain(")");
    expect(result).not.toContain("[");
    expect(result).not.toContain("]");
  });

  test("strips column filter syntax", () => {
    const result = parseSearchQuery("content:injection");
    expect(result).not.toContain(":");
  });

  test("handles dangling asterisks", () => {
    const result = parseSearchQuery("* hello *");
    expect(result).toBe("hello");
  });

  test("handles NEAR operator", () => {
    const result = parseSearchQuery("hello NEAR world");
    expect(result).not.toContain("NEAR");
  });

  test("handles mixed phrases and terms", () => {
    const result = parseSearchQuery('"machine learning" python tensorflow*');
    expect(result).toContain('"machine learning"');
    expect(result).toContain("python");
    expect(result).toContain("tensorflow*");
  });
});

describe("BM25Retriever", () => {
  test("returns empty array for empty query", async () => {
    const ctx = await createTestContext("bm25-empty-");
    const result = ctx.retriever.search("");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("returns empty array for whitespace-only query", async () => {
    const ctx = await createTestContext("bm25-ws-");
    const result = ctx.retriever.search("   ");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("returns empty array when no memories match", async () => {
    const ctx = await createTestContext("bm25-nomatch-");

    await ctx.repository.create(
      createInput({ content: "The weather is sunny today." }),
    );

    const result = ctx.retriever.search("quantum physics");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("finds memories matching a keyword", async () => {
    const ctx = await createTestContext("bm25-keyword-");

    const created = await ctx.repository.create(
      createInput({ content: "TypeScript is a strongly typed programming language." }),
    );
    expect(created.ok).toBe(true);

    await ctx.repository.create(
      createInput({ content: "The weather is sunny today." }),
    );

    const result = ctx.retriever.search("TypeScript");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].content).toContain("TypeScript");
      expect(result.value[0].bm25Score).toBeGreaterThanOrEqual(0);
      expect(result.value[0].bm25Score).toBeLessThanOrEqual(1);
    }
  });

  test("finds memories with phrase search", async () => {
    const ctx = await createTestContext("bm25-phrase-");

    await ctx.repository.create(
      createInput({ content: "Machine learning is a subset of artificial intelligence." }),
    );
    await ctx.repository.create(
      createInput({ content: "The machine was running all day for learning purposes." }),
    );

    const result = ctx.retriever.search('"machine learning"');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBeGreaterThanOrEqual(1);
      // The phrase match should find the first memory
      const contents = result.value.map((r) => r.content);
      expect(contents.some((c) => c.includes("subset of artificial intelligence"))).toBe(true);
    }
  });

  test("finds memories with prefix search", async () => {
    const ctx = await createTestContext("bm25-prefix-");

    await ctx.repository.create(
      createInput({ content: "Programming in TypeScript requires understanding types." }),
    );
    await ctx.repository.create(
      createInput({ content: "The cat sat on the mat." }),
    );

    const result = ctx.retriever.search("program*");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].content).toContain("Programming");
    }
  });

  test("returns results with correct structure", async () => {
    const ctx = await createTestContext("bm25-structure-");

    const created = await ctx.repository.create(
      createInput({
        content: "User prefers dark mode for all applications.",
        type: "preference",
        layer: "ltm",
        importance: 0.8,
      }),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = ctx.retriever.search("dark mode");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      const item = result.value[0];
      expect(item.memoryId).toBe(created.value.id);
      expect(item.content).toBe("User prefers dark mode for all applications.");
      expect(item.type).toBe("preference");
      expect(item.layer).toBe("ltm");
      expect(item.importance).toBe(0.8);
      expect(typeof item.bm25Score).toBe("number");
      expect(typeof item.snippet).toBe("string");
      expect(item.snippet.length).toBeGreaterThan(0);
    }
  });

  test("respects limit option", async () => {
    const ctx = await createTestContext("bm25-limit-");

    for (let i = 0; i < 5; i++) {
      await ctx.repository.create(
        createInput({ content: `Database optimization technique number ${i + 1}.` }),
      );
    }

    const result = ctx.retriever.search("database", { limit: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
    }
  });

  test("filters by memory type", async () => {
    const ctx = await createTestContext("bm25-type-filter-");

    await ctx.repository.create(
      createInput({
        content: "User prefers dark mode for coding.",
        type: "preference",
      }),
    );
    await ctx.repository.create(
      createInput({
        content: "Dark mode reduces eye strain, a known fact.",
        type: "fact",
      }),
    );

    const result = ctx.retriever.search("dark mode", {
      memoryTypes: ["preference"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].type).toBe("preference");
    }
  });

  test("filters by memory layer", async () => {
    const ctx = await createTestContext("bm25-layer-filter-");

    await ctx.repository.create(
      createInput({
        content: "Short-term note about TypeScript generics.",
        layer: "stm",
      }),
    );
    await ctx.repository.create(
      createInput({
        content: "Long-term knowledge about TypeScript patterns.",
        layer: "ltm",
      }),
    );

    const result = ctx.retriever.search("TypeScript", {
      layers: ["ltm"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].layer).toBe("ltm");
    }
  });

  test("filters by source type", async () => {
    const ctx = await createTestContext("bm25-source-filter-");

    await ctx.repository.create(
      createInput({
        content: "Explicitly remembered: Bun is fast.",
        source: { type: "explicit", conversationId: "conv_1" },
      }),
    );
    await ctx.repository.create(
      createInput({
        content: "Implicitly extracted: Bun runtime preference.",
        source: { type: "implicit", conversationId: "conv_2" },
      }),
    );

    const result = ctx.retriever.search("Bun", {
      sourceTypes: ["explicit"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].content).toContain("Explicitly");
    }
  });

  test("combines multiple filters", async () => {
    const ctx = await createTestContext("bm25-multi-filter-");

    await ctx.repository.create(
      createInput({
        content: "React hooks are powerful for state management.",
        type: "fact",
        layer: "ltm",
        source: { type: "explicit", conversationId: "conv_1" },
      }),
    );
    await ctx.repository.create(
      createInput({
        content: "React class components are legacy for state management.",
        type: "fact",
        layer: "stm",
        source: { type: "implicit", conversationId: "conv_2" },
      }),
    );
    await ctx.repository.create(
      createInput({
        content: "User prefers React functional components for state management.",
        type: "preference",
        layer: "ltm",
        source: { type: "explicit", conversationId: "conv_3" },
      }),
    );

    const result = ctx.retriever.search("state management", {
      memoryTypes: ["fact"],
      layers: ["ltm"],
      sourceTypes: ["explicit"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].content).toContain("React hooks");
    }
  });

  test("applies minScore threshold", async () => {
    const ctx = await createTestContext("bm25-minscore-");

    await ctx.repository.create(
      createInput({ content: "SQLite database performance optimization techniques." }),
    );
    await ctx.repository.create(
      createInput({ content: "The database was slow yesterday." }),
    );

    // With a very high threshold, fewer results should pass
    const result = ctx.retriever.search("database", { minScore: 0.99 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      for (const r of result.value) {
        expect(r.bm25Score).toBeGreaterThanOrEqual(0.99);
      }
    }
  });

  test("ranks more relevant results higher", async () => {
    const ctx = await createTestContext("bm25-ranking-");

    await ctx.repository.create(
      createInput({
        content: "SQLite is a database engine. SQLite supports FTS5 for full-text search in SQLite databases.",
      }),
    );
    await ctx.repository.create(
      createInput({
        content: "The weather forecast mentions rain tomorrow.",
      }),
    );
    await ctx.repository.create(
      createInput({
        content: "SQLite can be embedded in applications.",
      }),
    );

    const result = ctx.retriever.search("SQLite");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(2);
      // The memory with more "SQLite" mentions should rank higher (score closer to 1.0)
      expect(result.value[0].bm25Score).toBeGreaterThanOrEqual(result.value[1].bm25Score);
    }
  });

  test("handles query with only unsafe characters gracefully", async () => {
    const ctx = await createTestContext("bm25-unsafe-");

    await ctx.repository.create(
      createInput({ content: "Some test content." }),
    );

    const result = ctx.retriever.search("{}()[]");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });

  test("snippet contains relevant excerpt", async () => {
    const ctx = await createTestContext("bm25-snippet-");

    await ctx.repository.create(
      createInput({
        content: "The Rust programming language provides memory safety without garbage collection through its ownership system.",
      }),
    );

    const result = ctx.retriever.search("Rust programming");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.length).toBe(1);
      expect(result.value[0].snippet.length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeBM25Scores", () => {
  test("returns empty array for empty input", () => {
    expect(normalizeBM25Scores([])).toEqual([]);
  });

  test("returns 1.0 for single result", () => {
    const input: BM25SearchResult[] = [
      {
        memoryId: "1",
        content: "test",
        type: "fact",
        layer: "stm",
        importance: 0.5,
        bm25Score: -3.5,
        snippet: "test",
      },
    ];

    const result = normalizeBM25Scores(input);
    expect(result.length).toBe(1);
    expect(result[0].bm25Score).toBe(1.0);
  });

  test("normalizes scores to 0-1 range", () => {
    const input: BM25SearchResult[] = [
      {
        memoryId: "1",
        content: "best match",
        type: "fact",
        layer: "stm",
        importance: 0.5,
        bm25Score: -10.0,
        snippet: "best",
      },
      {
        memoryId: "2",
        content: "medium match",
        type: "fact",
        layer: "stm",
        importance: 0.5,
        bm25Score: -5.0,
        snippet: "medium",
      },
      {
        memoryId: "3",
        content: "worst match",
        type: "fact",
        layer: "stm",
        importance: 0.5,
        bm25Score: -1.0,
        snippet: "worst",
      },
    ];

    const result = normalizeBM25Scores(input);
    expect(result.length).toBe(3);

    for (const r of result) {
      expect(r.bm25Score).toBeGreaterThanOrEqual(0);
      expect(r.bm25Score).toBeLessThanOrEqual(1);
    }

    // Most negative raw score should map to highest normalized score
    expect(result[0].bm25Score).toBe(1.0);
    // Least negative raw score should map to lowest normalized score
    expect(result[2].bm25Score).toBe(0.0);
  });

  test("returns 1.0 for all results when scores are identical", () => {
    const input: BM25SearchResult[] = [
      {
        memoryId: "1",
        content: "a",
        type: "fact",
        layer: "stm",
        importance: 0.5,
        bm25Score: -5.0,
        snippet: "a",
      },
      {
        memoryId: "2",
        content: "b",
        type: "fact",
        layer: "stm",
        importance: 0.5,
        bm25Score: -5.0,
        snippet: "b",
      },
    ];

    const result = normalizeBM25Scores(input);
    expect(result[0].bm25Score).toBe(1.0);
    expect(result[1].bm25Score).toBe(1.0);
  });

  test("preserves non-score fields", () => {
    const input: BM25SearchResult[] = [
      {
        memoryId: "abc-123",
        content: "original content",
        type: "preference",
        layer: "ltm",
        importance: 0.9,
        bm25Score: -7.0,
        snippet: "original snippet",
      },
    ];

    const result = normalizeBM25Scores(input);
    expect(result[0].memoryId).toBe("abc-123");
    expect(result[0].content).toBe("original content");
    expect(result[0].type).toBe("preference");
    expect(result[0].layer).toBe("ltm");
    expect(result[0].importance).toBe(0.9);
    expect(result[0].snippet).toBe("original snippet");
  });
});
