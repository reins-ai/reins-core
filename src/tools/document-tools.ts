import { basename, dirname } from "node:path";

import type { DocumentIndexer } from "../memory/rag/document-indexer";
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
