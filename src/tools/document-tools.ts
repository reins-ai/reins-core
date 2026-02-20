import { basename, dirname } from "node:path";

import type { DocumentIndexer } from "../memory/rag/document-indexer";
import type { HybridDocumentSearch, RankedChunk } from "../memory/rag/document-semantic-search";
import type { DocumentSourceRegistry } from "../memory/rag/document-source-registry";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";

export interface DocumentIndexToolOptions {
  indexer: DocumentIndexer;
  registry: DocumentSourceRegistry;
}

export class DocumentIndexTool implements Tool {
  definition: ToolDefinition = {
    name: "index_document",
    description:
      "Index a document file for semantic search. " +
      "Registers the file's directory as a source if needed, " +
      "then indexes the file into searchable chunks.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the document file to index.",
        },
        source_name: {
          type: "string",
          description:
            "Optional human-readable name for the document source. " +
            "Defaults to the filename.",
        },
      },
      required: ["path"],
    },
  };

  private readonly indexer: DocumentIndexer;
  private readonly registry: DocumentSourceRegistry;

  constructor(options: DocumentIndexToolOptions) {
    this.indexer = options.indexer;
    this.registry = options.registry;
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";

    const path = this.readString(args.path);
    if (!path) {
      return this.errorResult(
        callId,
        "'path' is required and must be a non-empty string.",
      );
    }

    const sourceName = this.readString(args.source_name) ?? basename(path);

    try {
      const sourceResult = this.ensureSource(path, sourceName);
      if (!sourceResult.ok) {
        return this.errorResult(callId, sourceResult.error);
      }

      const sourceId = sourceResult.value;

      const indexResult = await this.indexer.indexFile(path, sourceId);
      if (!indexResult.ok) {
        return this.errorResult(callId, indexResult.error.message);
      }

      const chunks = indexResult.value;
      const fileName = basename(path);

      return this.successResult(callId, {
        action: "index_document",
        path,
        source_name: sourceName,
        source_id: sourceId,
        chunks_indexed: chunks.length,
        message: `Indexed ${chunks.length} chunks from ${fileName} (source: ${sourceName})`,
      });
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private ensureSource(
    filePath: string,
    sourceName: string,
  ): { ok: true; value: string } | { ok: false; error: string } {
    const rootPath = dirname(filePath);

    const existingSources = this.registry.list();
    for (const source of existingSources) {
      if (source.rootPath === rootPath && source.status !== "removed") {
        return { ok: true, value: source.id };
      }
    }

    const registerResult = this.registry.register(rootPath, {
      name: sourceName,
    });

    if (!registerResult.ok) {
      if (registerResult.error.code === "SOURCE_ALREADY_REGISTERED") {
        const allSources = this.registry.list();
        const match = allSources.find(
          (s) => s.rootPath === rootPath && s.status !== "removed",
        );
        if (match) {
          return { ok: true, value: match.id };
        }
      }
      return { ok: false, error: registerResult.error.message };
    }

    return { ok: true, value: registerResult.value.id };
  }

  private successResult(callId: string, result: unknown): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result,
    };
  }

  private errorResult(callId: string, error: string): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result: null,
      error,
    };
  }

  private readString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Document indexing failed.";
  }
}

const DEFAULT_SEARCH_TOP_K = 5;
const CONTENT_PREVIEW_LENGTH = 200;

export interface DocumentSearchToolOptions {
  search: HybridDocumentSearch;
  indexer: DocumentIndexer;
  registry: DocumentSourceRegistry;
}

export class DocumentSearchTool implements Tool {
  definition: ToolDefinition = {
    name: "search_documents",
    description:
      "Search indexed documents using semantic and keyword matching. " +
      "Returns ranked results with content previews, relevance scores, " +
      "and source metadata.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to find relevant document chunks.",
        },
        top_k: {
          type: "number",
          description:
            "Maximum number of results to return. Defaults to 5.",
        },
        source: {
          type: "string",
          description:
            "Optional source path filter to restrict search to a specific document or directory.",
        },
      },
      required: ["query"],
    },
  };

  private readonly search: HybridDocumentSearch;
  private readonly indexer: DocumentIndexer;
  private readonly registry: DocumentSourceRegistry;

  constructor(options: DocumentSearchToolOptions) {
    this.search = options.search;
    this.indexer = options.indexer;
    this.registry = options.registry;
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";

    const query = this.readString(args.query);
    if (!query) {
      return this.errorResult(
        callId,
        "'query' is required and must be a non-empty string.",
      );
    }

    const topK = this.readPositiveInt(args.top_k) ?? DEFAULT_SEARCH_TOP_K;
    const source = this.readString(args.source) ?? undefined;

    try {
      const chunks = this.collectChunks(source);
      const results = await this.search.search(query, chunks, {
        topK,
        sourceFilter: source,
      });

      if (results.length === 0) {
        return this.successResult(callId, {
          action: "search_documents",
          query,
          results_count: 0,
          message: `No results found for "${query}".`,
          results: [],
        });
      }

      const formatted = this.formatResults(query, results);

      return this.successResult(callId, {
        action: "search_documents",
        query,
        results_count: results.length,
        message: formatted,
        results: results.map((r) => ({
          score: Math.round(r.score * 100) / 100,
          source_path: r.source.path,
          heading: r.source.heading,
          content_preview: this.truncateContent(r.chunk.content),
        })),
      });
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private collectChunks(
    sourceFilter: string | undefined,
  ): import("../memory/rag/document-indexer").IndexedChunk[] {
    const sources = this.registry.list();
    const chunks: import("../memory/rag/document-indexer").IndexedChunk[] = [];

    for (const source of sources) {
      if (source.status === "removed") {
        continue;
      }

      const sourceChunks = this.indexer.getChunksBySource(source.id);
      for (const chunk of sourceChunks) {
        if (
          !sourceFilter ||
          chunk.sourcePath === sourceFilter ||
          chunk.sourcePath.startsWith(`${sourceFilter}/`)
        ) {
          chunks.push(chunk);
        }
      }
    }

    return chunks;
  }

  private formatResults(query: string, results: RankedChunk[]): string {
    const header = `Found ${results.length} result${results.length === 1 ? "" : "s"} for "${query}":`;
    const entries = results.map((r, i) => {
      const num = i + 1;
      const score = r.score.toFixed(2);
      const heading = r.source.heading ? ` (${r.source.heading})` : "";
      const source = `Source: ${r.source.path}${heading}`;
      const preview = this.truncateContent(r.chunk.content);
      return `${num}. [Score: ${score}] ${source}\n"${preview}"`;
    });

    return header + "\n\n" + entries.join("\n\n");
  }

  private truncateContent(content: string): string {
    const cleaned = content.replace(/\s+/g, " ").trim();
    if (cleaned.length <= CONTENT_PREVIEW_LENGTH) {
      return cleaned;
    }
    return cleaned.slice(0, CONTENT_PREVIEW_LENGTH) + "...";
  }

  private successResult(callId: string, result: unknown): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result,
    };
  }

  private errorResult(callId: string, error: string): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result: null,
      error,
    };
  }

  private readString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private readPositiveInt(value: unknown): number | null {
    if (typeof value !== "number") {
      return null;
    }

    if (!Number.isFinite(value) || value <= 0) {
      return null;
    }

    return Math.trunc(value);
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Document search failed.";
  }
}
