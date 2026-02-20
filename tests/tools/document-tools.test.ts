import { describe, expect, it } from "bun:test";

import {
  DocumentIndexTool,
  DocumentSearchTool,
  getBuiltinToolDefinitions,
  INDEX_DOCUMENT_DEFINITION,
  SEARCH_DOCUMENTS_DEFINITION,
  ToolRegistry,
} from "../../src/tools";
import type { ToolContext } from "../../src/types";
import type { DocumentIndexer, IndexedChunk } from "../../src/memory/rag/document-indexer";
import type { DocumentChunk } from "../../src/memory/rag/markdown-chunker";
import type {
  DocumentSource,
  DocumentSourceRegistry,
  RegisterOptions,
} from "../../src/memory/rag/document-source-registry";
import type { DocumentSourceRegistryError } from "../../src/memory/rag/document-source-registry";
import type { HybridDocumentSearch, RankedChunk, DocumentSearchOptions } from "../../src/memory/rag/document-semantic-search";
import { ok, err } from "../../src/result";
import { MemoryError } from "../../src/memory/services/memory-error";

const toolContext: ToolContext = {
  conversationId: "conv-doc-123",
  userId: "user-doc-123",
  workspaceId: "ws-doc-123",
};

function makeChunk(overrides?: Partial<DocumentChunk>): DocumentChunk {
  return {
    id: "chunk-1",
    sourceId: "src-1",
    sourcePath: "/docs/report.md",
    heading: "Introduction",
    headingHierarchy: ["Introduction"],
    content: "Some document content here.",
    startOffset: 0,
    endOffset: 100,
    chunkIndex: 0,
    totalChunks: 1,
    metadata: {
      wordCount: 5,
      lineCount: 1,
      hasCodeBlock: false,
      hasFrontmatter: false,
      headingDepth: 1,
      strategy: "heading",
    },
    ...overrides,
  };
}

function makeSource(overrides?: Partial<DocumentSource>): DocumentSource {
  return {
    id: "src-abc123",
    rootPath: "/docs",
    name: "docs",
    policy: {
      includePaths: ["**/*.md"],
      excludePaths: [],
      maxFileSize: 1_048_576,
      maxDepth: 10,
      watchForChanges: false,
    },
    status: "registered",
    registeredAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

interface MockRegistryOptions {
  listResult?: DocumentSource[];
  registerResult?: { ok: true; value: DocumentSource } | { ok: false; error: DocumentSourceRegistryError };
  getResult?: { ok: true; value: DocumentSource | null } | { ok: false; error: DocumentSourceRegistryError };
}

function createMockRegistry(options?: MockRegistryOptions): DocumentSourceRegistry {
  const sources = options?.listResult ?? [];

  return {
    list: () => sources,
    register: (_rootPath: string, _options?: RegisterOptions) => {
      if (options?.registerResult) {
        return options.registerResult;
      }
      const source = makeSource({ rootPath: _rootPath, name: _options?.name ?? "docs" });
      return ok(source);
    },
    get: (_id: string) => {
      if (options?.getResult) {
        return options.getResult;
      }
      return ok(null);
    },
    unregister: () => ok(undefined),
    updateStatus: () => ok(makeSource()),
    getCheckpoint: () => ok(null),
    saveCheckpoint: () => ok(undefined),
  } as unknown as DocumentSourceRegistry;
}

interface MockIndexerOptions {
  indexFileResult?: ReturnType<DocumentIndexer["indexFile"]>;
  chunksBySource?: Map<string, IndexedChunk[]>;
}

function createMockIndexer(options?: MockIndexerOptions): DocumentIndexer {
  return {
    indexFile: async () => {
      if (options?.indexFileResult) {
        return options.indexFileResult;
      }
      return ok([makeChunk()]);
    },
    indexSource: async () => ok({
      id: "job-1",
      sourceId: "src-1",
      status: "complete" as const,
      chunksProcessed: 1,
      chunksTotal: 1,
      embeddingsGenerated: 1,
      errors: [],
      embeddingProvider: "test",
      embeddingModel: "test-model",
      embeddingDimensions: 384,
    }),
    removeSource: async () => ok(undefined),
    getChunksBySource: (sourceId: string) => {
      return options?.chunksBySource?.get(sourceId) ?? [];
    },
    getChunk: () => undefined,
    searchByContent: () => [],
  } as unknown as DocumentIndexer;
}

describe("DocumentIndexTool", () => {
  it("has correct tool definition", () => {
    const tool = new DocumentIndexTool({
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    expect(tool.definition.name).toBe("index_document");
    expect(tool.definition.parameters.required).toEqual(["path"]);
    expect(tool.definition.parameters.properties.path).toBeDefined();
    expect(tool.definition.parameters.properties.source_name).toBeDefined();
  });

  it("registers in ToolRegistry", () => {
    const tool = new DocumentIndexTool({
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });
    const registry = new ToolRegistry();

    registry.register(tool);

    const definitions = registry.getDefinitions();
    const found = definitions.find((d) => d.name === "index_document");
    expect(found).toBeDefined();
    expect(found?.parameters.required).toEqual(["path"]);
  });

  it("indexes a document and returns progress report", async () => {
    const chunks = [
      makeChunk({ id: "c1", chunkIndex: 0 }),
      makeChunk({ id: "c2", chunkIndex: 1 }),
      makeChunk({ id: "c3", chunkIndex: 2 }),
    ];

    const tool = new DocumentIndexTool({
      indexer: createMockIndexer({
        indexFileResult: Promise.resolve(ok(chunks)),
      }),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "call-1", path: "/docs/report.md" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as {
      action: string;
      path: string;
      source_name: string;
      source_id: string;
      chunks_indexed: number;
      message: string;
    };
    expect(payload.action).toBe("index_document");
    expect(payload.path).toBe("/docs/report.md");
    expect(payload.chunks_indexed).toBe(3);
    expect(payload.message).toContain("3 chunks");
    expect(payload.message).toContain("report.md");
  });

  it("uses source_name when provided", async () => {
    const tool = new DocumentIndexTool({
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "call-2", path: "/docs/report.md", source_name: "reports" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as {
      source_name: string;
      message: string;
    };
    expect(payload.source_name).toBe("reports");
    expect(payload.message).toContain("(source: reports)");
  });

  it("defaults source_name to filename when not provided", async () => {
    const tool = new DocumentIndexTool({
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "call-3", path: "/docs/my-notes.md" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { source_name: string };
    expect(payload.source_name).toBe("my-notes.md");
  });

  it("reuses existing source when directory already registered", async () => {
    let registerCalled = false;
    const existingSource = makeSource({
      id: "existing-src",
      rootPath: "/docs",
      name: "existing-docs",
    });

    const mockRegistry = createMockRegistry({
      listResult: [existingSource],
    });
    const originalRegister = mockRegistry.register.bind(mockRegistry);
    mockRegistry.register = (...registerArgs: Parameters<typeof mockRegistry.register>) => {
      registerCalled = true;
      return originalRegister(...registerArgs);
    };

    const tool = new DocumentIndexTool({
      indexer: createMockIndexer(),
      registry: mockRegistry,
    });

    const result = await tool.execute(
      { callId: "call-4", path: "/docs/report.md" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(registerCalled).toBe(false);
    const payload = result.result as { source_id: string };
    expect(payload.source_id).toBe("existing-src");
  });

  it("skips removed sources when looking for existing", async () => {
    const removedSource = makeSource({
      id: "removed-src",
      rootPath: "/docs",
      status: "removed",
    });

    let registeredPath: string | undefined;
    const mockRegistry = {
      list: () => [removedSource],
      register: (rootPath: string, _options?: RegisterOptions) => {
        registeredPath = rootPath;
        return ok(makeSource({ id: "new-src", rootPath }));
      },
      get: () => ok(null),
      unregister: () => ok(undefined),
      updateStatus: () => ok(makeSource()),
      getCheckpoint: () => ok(null),
      saveCheckpoint: () => ok(undefined),
    } as unknown as DocumentSourceRegistry;

    const tool = new DocumentIndexTool({
      indexer: createMockIndexer(),
      registry: mockRegistry,
    });

    const result = await tool.execute(
      { callId: "call-5", path: "/docs/report.md" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(registeredPath).toBe("/docs");
    const payload = result.result as { source_id: string };
    expect(payload.source_id).toBe("new-src");
  });

  it("returns error when path is missing", async () => {
    const tool = new DocumentIndexTool({
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "call-err-1" },
      toolContext,
    );

    expect(result.error).toBe(
      "'path' is required and must be a non-empty string.",
    );
    expect(result.result).toBeNull();
  });

  it("returns error when path is empty string", async () => {
    const tool = new DocumentIndexTool({
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "call-err-2", path: "   " },
      toolContext,
    );

    expect(result.error).toBe(
      "'path' is required and must be a non-empty string.",
    );
  });

  it("returns error when indexFile fails", async () => {
    const tool = new DocumentIndexTool({
      indexer: createMockIndexer({
        indexFileResult: Promise.resolve(
          err(new MemoryError("File not found: /missing.md", "MEMORY_DB_ERROR")),
        ),
      }),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "call-err-3", path: "/missing.md" },
      toolContext,
    );

    expect(result.error).toBe("File not found: /missing.md");
    expect(result.result).toBeNull();
  });

  it("returns error when source registration fails", async () => {
    const registryError = {
      message: "rootPath must be a non-empty string",
      code: "INVALID_ROOT_PATH",
      name: "DocumentSourceRegistryError",
    } as DocumentSourceRegistryError;

    const tool = new DocumentIndexTool({
      indexer: createMockIndexer(),
      registry: createMockRegistry({
        registerResult: err(registryError),
      }),
    });

    const result = await tool.execute(
      { callId: "call-err-4", path: "/docs/report.md" },
      toolContext,
    );

    expect(result.error).toBe("rootPath must be a non-empty string");
  });

  it("handles indexer throwing an exception", async () => {
    const throwingIndexer = {
      indexFile: async () => {
        throw new Error("Unexpected embedding failure");
      },
    } as unknown as DocumentIndexer;

    const tool = new DocumentIndexTool({
      indexer: throwingIndexer,
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "call-err-5", path: "/docs/report.md" },
      toolContext,
    );

    expect(result.error).toBe("Unexpected embedding failure");
    expect(result.result).toBeNull();
  });

  it("handles zero chunks indexed", async () => {
    const tool = new DocumentIndexTool({
      indexer: createMockIndexer({
        indexFileResult: Promise.resolve(ok([])),
      }),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "call-zero", path: "/docs/empty.md" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as {
      chunks_indexed: number;
      message: string;
    };
    expect(payload.chunks_indexed).toBe(0);
    expect(payload.message).toContain("0 chunks");
  });
});

describe("INDEX_DOCUMENT_DEFINITION", () => {
  it("has correct name and required fields", () => {
    expect(INDEX_DOCUMENT_DEFINITION.name).toBe("index_document");
    expect(INDEX_DOCUMENT_DEFINITION.parameters.required).toEqual(["path"]);
    expect(INDEX_DOCUMENT_DEFINITION.parameters.properties.path).toBeDefined();
    expect(INDEX_DOCUMENT_DEFINITION.parameters.properties.source_name).toBeDefined();
  });

  it("is included in getBuiltinToolDefinitions", () => {
    const definitions = getBuiltinToolDefinitions();
    const found = definitions.find((d) => d.name === "index_document");
    expect(found).toBeDefined();
    expect(found?.parameters.required).toEqual(["path"]);
  });
});

function makeIndexedChunk(overrides?: Partial<IndexedChunk>): IndexedChunk {
  return {
    id: "idx-chunk-1",
    sourceId: "src-1",
    sourcePath: "/docs/contract.pdf",
    heading: "Section 4",
    headingHierarchy: ["Section 4"],
    content: "The licensee agrees to the terms outlined in this section.",
    startOffset: 0,
    endOffset: 200,
    chunkIndex: 0,
    totalChunks: 3,
    metadata: {
      wordCount: 10,
      lineCount: 1,
      hasCodeBlock: false,
      hasFrontmatter: false,
      headingDepth: 1,
      strategy: "heading",
    },
    embedding: new Float32Array([0.1, 0.2, 0.3]),
    ftsIndexed: true,
    embeddingMetadata: {
      provider: "test",
      model: "test-model",
      dimensions: 3,
      version: "1.0",
      indexedAt: "2026-01-01T00:00:00.000Z",
      indexVersion: "v1",
    },
    ...overrides,
  };
}

interface MockSearchOptions {
  searchResult?: RankedChunk[];
  searchError?: Error;
}

function createMockSearch(options?: MockSearchOptions): HybridDocumentSearch {
  return {
    search: async (
      _query: string,
      _chunksOrTopK: IndexedChunk[] | number,
      _options?: DocumentSearchOptions | { sourceIds?: string[] },
    ) => {
      if (options?.searchError) {
        throw options.searchError;
      }
      return options?.searchResult ?? [];
    },
  } as unknown as HybridDocumentSearch;
}

function makeRankedChunk(
  chunk: IndexedChunk,
  score: number,
  overrides?: Partial<RankedChunk>,
): RankedChunk {
  return {
    chunk,
    score,
    semanticScore: score * 0.7,
    keywordScore: score * 0.3,
    source: {
      path: chunk.sourcePath,
      heading: chunk.heading,
    },
    ...overrides,
  };
}

describe("DocumentSearchTool", () => {
  it("has correct tool definition", () => {
    const tool = new DocumentSearchTool({
      search: createMockSearch(),
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    expect(tool.definition.name).toBe("search_documents");
    expect(tool.definition.parameters.required).toEqual(["query"]);
    expect(tool.definition.parameters.properties.query).toBeDefined();
    expect(tool.definition.parameters.properties.top_k).toBeDefined();
    expect(tool.definition.parameters.properties.source).toBeDefined();
  });

  it("registers in ToolRegistry", () => {
    const tool = new DocumentSearchTool({
      search: createMockSearch(),
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });
    const registry = new ToolRegistry();

    registry.register(tool);

    const definitions = registry.getDefinitions();
    const found = definitions.find((d) => d.name === "search_documents");
    expect(found).toBeDefined();
    expect(found?.parameters.required).toEqual(["query"]);
  });

  it("returns ranked results with scores and source metadata", async () => {
    const chunk1 = makeIndexedChunk({
      id: "c1",
      sourcePath: "/docs/contract.pdf",
      heading: "Section 4",
      content: "The licensee agrees to the terms outlined in this section.",
    });
    const chunk2 = makeIndexedChunk({
      id: "c2",
      sourcePath: "/docs/contract.pdf",
      heading: "Section 2",
      content: "Payment terms include net-30 billing cycle.",
    });

    const rankedResults = [
      makeRankedChunk(chunk1, 0.89),
      makeRankedChunk(chunk2, 0.76),
    ];

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set("src-1", [chunk1, chunk2]);

    const tool = new DocumentSearchTool({
      search: createMockSearch({ searchResult: rankedResults }),
      indexer: createMockIndexer({ chunksBySource }),
      registry: createMockRegistry({
        listResult: [makeSource({ id: "src-1" })],
      }),
    });

    const result = await tool.execute(
      { callId: "search-1", query: "contract section 4" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as {
      action: string;
      query: string;
      results_count: number;
      message: string;
      results: Array<{
        score: number;
        source_path: string;
        heading: string | null;
        content_preview: string;
      }>;
    };
    expect(payload.action).toBe("search_documents");
    expect(payload.query).toBe("contract section 4");
    expect(payload.results_count).toBe(2);
    expect(payload.results[0].score).toBe(0.89);
    expect(payload.results[0].source_path).toBe("/docs/contract.pdf");
    expect(payload.results[0].heading).toBe("Section 4");
    expect(payload.results[1].score).toBe(0.76);
    expect(payload.message).toContain("Found 2 results");
    expect(payload.message).toContain("[Score: 0.89]");
    expect(payload.message).toContain("Section 4");
  });

  it("returns empty results when no matches found", async () => {
    const tool = new DocumentSearchTool({
      search: createMockSearch({ searchResult: [] }),
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "search-empty", query: "nonexistent topic" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as {
      results_count: number;
      message: string;
      results: unknown[];
    };
    expect(payload.results_count).toBe(0);
    expect(payload.results).toEqual([]);
    expect(payload.message).toContain("No results found");
  });

  it("returns error when query is missing", async () => {
    const tool = new DocumentSearchTool({
      search: createMockSearch(),
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "search-err-1" },
      toolContext,
    );

    expect(result.error).toBe(
      "'query' is required and must be a non-empty string.",
    );
    expect(result.result).toBeNull();
  });

  it("returns error when query is empty string", async () => {
    const tool = new DocumentSearchTool({
      search: createMockSearch(),
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "search-err-2", query: "   " },
      toolContext,
    );

    expect(result.error).toBe(
      "'query' is required and must be a non-empty string.",
    );
  });

  it("passes top_k to search", async () => {
    let capturedOptions: DocumentSearchOptions | undefined;
    const mockSearch = {
      search: async (
        _query: string,
        _chunks: IndexedChunk[],
        options?: DocumentSearchOptions,
      ) => {
        capturedOptions = options;
        return [];
      },
    } as unknown as HybridDocumentSearch;

    const tool = new DocumentSearchTool({
      search: mockSearch,
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    await tool.execute(
      { callId: "search-topk", query: "test", top_k: 3 },
      toolContext,
    );

    expect(capturedOptions?.topK).toBe(3);
  });

  it("uses default top_k of 5 when not provided", async () => {
    let capturedOptions: DocumentSearchOptions | undefined;
    const mockSearch = {
      search: async (
        _query: string,
        _chunks: IndexedChunk[],
        options?: DocumentSearchOptions,
      ) => {
        capturedOptions = options;
        return [];
      },
    } as unknown as HybridDocumentSearch;

    const tool = new DocumentSearchTool({
      search: mockSearch,
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    await tool.execute(
      { callId: "search-default-topk", query: "test" },
      toolContext,
    );

    expect(capturedOptions?.topK).toBe(5);
  });

  it("passes source filter to search", async () => {
    let capturedOptions: DocumentSearchOptions | undefined;
    const mockSearch = {
      search: async (
        _query: string,
        _chunks: IndexedChunk[],
        options?: DocumentSearchOptions,
      ) => {
        capturedOptions = options;
        return [];
      },
    } as unknown as HybridDocumentSearch;

    const tool = new DocumentSearchTool({
      search: mockSearch,
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    await tool.execute(
      { callId: "search-source", query: "test", source: "/docs/contract.pdf" },
      toolContext,
    );

    expect(capturedOptions?.sourceFilter).toBe("/docs/contract.pdf");
  });

  it("collects chunks from all registered sources", async () => {
    let capturedChunks: IndexedChunk[] = [];
    const mockSearch = {
      search: async (
        _query: string,
        chunks: IndexedChunk[],
        _options?: DocumentSearchOptions,
      ) => {
        capturedChunks = chunks;
        return [];
      },
    } as unknown as HybridDocumentSearch;

    const chunk1 = makeIndexedChunk({ id: "c1", sourceId: "src-1" });
    const chunk2 = makeIndexedChunk({ id: "c2", sourceId: "src-2" });

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set("src-1", [chunk1]);
    chunksBySource.set("src-2", [chunk2]);

    const tool = new DocumentSearchTool({
      search: mockSearch,
      indexer: createMockIndexer({ chunksBySource }),
      registry: createMockRegistry({
        listResult: [
          makeSource({ id: "src-1" }),
          makeSource({ id: "src-2", rootPath: "/other" }),
        ],
      }),
    });

    await tool.execute(
      { callId: "search-multi", query: "test" },
      toolContext,
    );

    expect(capturedChunks.length).toBe(2);
    expect(capturedChunks.map((c) => c.id).sort()).toEqual(["c1", "c2"]);
  });

  it("skips removed sources when collecting chunks", async () => {
    let capturedChunks: IndexedChunk[] = [];
    const mockSearch = {
      search: async (
        _query: string,
        chunks: IndexedChunk[],
        _options?: DocumentSearchOptions,
      ) => {
        capturedChunks = chunks;
        return [];
      },
    } as unknown as HybridDocumentSearch;

    const chunk1 = makeIndexedChunk({ id: "c1", sourceId: "src-active" });
    const chunk2 = makeIndexedChunk({ id: "c2", sourceId: "src-removed" });

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set("src-active", [chunk1]);
    chunksBySource.set("src-removed", [chunk2]);

    const tool = new DocumentSearchTool({
      search: mockSearch,
      indexer: createMockIndexer({ chunksBySource }),
      registry: createMockRegistry({
        listResult: [
          makeSource({ id: "src-active", status: "registered" }),
          makeSource({ id: "src-removed", status: "removed" }),
        ],
      }),
    });

    await tool.execute(
      { callId: "search-skip-removed", query: "test" },
      toolContext,
    );

    expect(capturedChunks.length).toBe(1);
    expect(capturedChunks[0].id).toBe("c1");
  });

  it("handles search throwing an exception", async () => {
    const tool = new DocumentSearchTool({
      search: createMockSearch({
        searchError: new Error("Embedding provider unavailable"),
      }),
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    const result = await tool.execute(
      { callId: "search-err-3", query: "test" },
      toolContext,
    );

    expect(result.error).toBe("Embedding provider unavailable");
    expect(result.result).toBeNull();
  });

  it("truncates long content previews", async () => {
    const longContent = "A".repeat(300);
    const chunk = makeIndexedChunk({ content: longContent });
    const rankedResults = [makeRankedChunk(chunk, 0.95)];

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set("src-1", [chunk]);

    const tool = new DocumentSearchTool({
      search: createMockSearch({ searchResult: rankedResults }),
      indexer: createMockIndexer({ chunksBySource }),
      registry: createMockRegistry({
        listResult: [makeSource({ id: "src-1" })],
      }),
    });

    const result = await tool.execute(
      { callId: "search-trunc", query: "test" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as {
      results: Array<{ content_preview: string }>;
    };
    expect(payload.results[0].content_preview.length).toBeLessThanOrEqual(203);
    expect(payload.results[0].content_preview).toEndWith("...");
  });

  it("formats single result without plural", async () => {
    const chunk = makeIndexedChunk();
    const rankedResults = [makeRankedChunk(chunk, 0.85)];

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set("src-1", [chunk]);

    const tool = new DocumentSearchTool({
      search: createMockSearch({ searchResult: rankedResults }),
      indexer: createMockIndexer({ chunksBySource }),
      registry: createMockRegistry({
        listResult: [makeSource({ id: "src-1" })],
      }),
    });

    const result = await tool.execute(
      { callId: "search-single", query: "test" },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { message: string };
    expect(payload.message).toContain("Found 1 result for");
    expect(payload.message).not.toContain("results for");
  });

  it("includes heading in formatted output when present", async () => {
    const chunk = makeIndexedChunk({ heading: "Important Section" });
    const rankedResults = [makeRankedChunk(chunk, 0.9)];

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set("src-1", [chunk]);

    const tool = new DocumentSearchTool({
      search: createMockSearch({ searchResult: rankedResults }),
      indexer: createMockIndexer({ chunksBySource }),
      registry: createMockRegistry({
        listResult: [makeSource({ id: "src-1" })],
      }),
    });

    const result = await tool.execute(
      { callId: "search-heading", query: "test" },
      toolContext,
    );

    const payload = result.result as { message: string };
    expect(payload.message).toContain("(Important Section)");
  });

  it("omits heading in formatted output when null", async () => {
    const chunk = makeIndexedChunk({ heading: null });
    const rankedResults = [
      makeRankedChunk(chunk, 0.9, {
        source: { path: chunk.sourcePath, heading: null },
      }),
    ];

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set("src-1", [chunk]);

    const tool = new DocumentSearchTool({
      search: createMockSearch({ searchResult: rankedResults }),
      indexer: createMockIndexer({ chunksBySource }),
      registry: createMockRegistry({
        listResult: [makeSource({ id: "src-1" })],
      }),
    });

    const result = await tool.execute(
      { callId: "search-no-heading", query: "test" },
      toolContext,
    );

    const payload = result.result as { message: string };
    expect(payload.message).not.toContain("(null)");
    expect(payload.message).not.toContain("()");
  });

  it("rounds scores to two decimal places", async () => {
    const chunk = makeIndexedChunk();
    const rankedResults = [makeRankedChunk(chunk, 0.8567)];

    const chunksBySource = new Map<string, IndexedChunk[]>();
    chunksBySource.set("src-1", [chunk]);

    const tool = new DocumentSearchTool({
      search: createMockSearch({ searchResult: rankedResults }),
      indexer: createMockIndexer({ chunksBySource }),
      registry: createMockRegistry({
        listResult: [makeSource({ id: "src-1" })],
      }),
    });

    const result = await tool.execute(
      { callId: "search-round", query: "test" },
      toolContext,
    );

    const payload = result.result as {
      results: Array<{ score: number }>;
    };
    expect(payload.results[0].score).toBe(0.86);
  });

  it("ignores invalid top_k values", async () => {
    let capturedOptions: DocumentSearchOptions | undefined;
    const mockSearch = {
      search: async (
        _query: string,
        _chunks: IndexedChunk[],
        options?: DocumentSearchOptions,
      ) => {
        capturedOptions = options;
        return [];
      },
    } as unknown as HybridDocumentSearch;

    const tool = new DocumentSearchTool({
      search: mockSearch,
      indexer: createMockIndexer(),
      registry: createMockRegistry(),
    });

    await tool.execute(
      { callId: "search-bad-topk", query: "test", top_k: -5 },
      toolContext,
    );

    expect(capturedOptions?.topK).toBe(5);
  });
});

describe("SEARCH_DOCUMENTS_DEFINITION", () => {
  it("has correct name and required fields", () => {
    expect(SEARCH_DOCUMENTS_DEFINITION.name).toBe("search_documents");
    expect(SEARCH_DOCUMENTS_DEFINITION.parameters.required).toEqual(["query"]);
    expect(SEARCH_DOCUMENTS_DEFINITION.parameters.properties.query).toBeDefined();
    expect(SEARCH_DOCUMENTS_DEFINITION.parameters.properties.top_k).toBeDefined();
    expect(SEARCH_DOCUMENTS_DEFINITION.parameters.properties.source).toBeDefined();
  });

  it("is included in getBuiltinToolDefinitions", () => {
    const definitions = getBuiltinToolDefinitions();
    const found = definitions.find((d) => d.name === "search_documents");
    expect(found).toBeDefined();
    expect(found?.parameters.required).toEqual(["query"]);
  });
});
