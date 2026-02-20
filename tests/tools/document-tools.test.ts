import { describe, expect, it } from "bun:test";

import {
  DocumentIndexTool,
  getBuiltinToolDefinitions,
  INDEX_DOCUMENT_DEFINITION,
  ToolRegistry,
} from "../../src/tools";
import type { ToolContext } from "../../src/types";
import type { DocumentIndexer } from "../../src/memory/rag/document-indexer";
import type { DocumentChunk } from "../../src/memory/rag/markdown-chunker";
import type {
  DocumentSource,
  DocumentSourceRegistry,
  RegisterOptions,
} from "../../src/memory/rag/document-source-registry";
import type { DocumentSourceRegistryError } from "../../src/memory/rag/document-source-registry";
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
    getChunksBySource: () => [],
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
