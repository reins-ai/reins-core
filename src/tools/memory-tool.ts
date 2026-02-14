import type { MemoryService, MemoryListOptions } from "../memory/services/memory-service";
import type { MemoryRecord } from "../memory/types/memory-record";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";

type MemoryAction = "remember" | "recall";

interface MemoryResultRecord {
  id: string;
  content: string;
  type: MemoryRecord["type"];
  layer: MemoryRecord["layer"];
  tags: string[];
  entities: string[];
  importance: number;
  confidence: number;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}

export class MemoryTool implements Tool {
  definition: ToolDefinition = {
    name: "memory",
    description:
      "Remember user details and recall relevant memories for better continuity across conversations.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["remember", "recall"],
        },
        content: {
          type: "string",
          description: "Memory content to persist when action is remember.",
        },
        tags: {
          type: "array",
          description: "Optional tags to attach to remembered content.",
          items: {
            type: "string",
          },
        },
        query: {
          type: "string",
          description: "Search query used when action is recall.",
        },
        limit: {
          type: "number",
          description: "Maximum number of recall results to return.",
        },
      },
      required: ["action"],
    },
  };

  constructor(private readonly memoryService: MemoryService) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";
    const action = this.normalizeAction(args.action);

    if (!action) {
      return this.errorResult(callId, "Missing or invalid 'action' argument.");
    }

    if (!this.memoryService.isReady()) {
      return this.errorResult(callId, "Memory service is not ready.");
    }

    try {
      switch (action) {
        case "remember":
          return await this.remember(callId, args, context);
        case "recall":
          return await this.recall(callId, args);
      }
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private async remember(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const content = this.requireString(args.content, "'content' is required for remember action.");
    const tags = this.optionalStringArray(args.tags, "'tags' must be an array of non-empty strings.");

    const result = await this.memoryService.rememberExplicit({
      content,
      tags,
      conversationId: context.conversationId,
    });
    if (!result.ok) {
      return this.errorResult(callId, result.error.message);
    }

    return this.successResult(callId, {
      action: "remember",
      memory: this.toResultRecord(result.value),
    });
  }

  private async recall(callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.requireString(args.query, "'query' is required for recall action.");
    const limit = this.optionalPositiveInteger(args.limit, "'limit' must be a positive integer.");

    const listOptions: MemoryListOptions = {
      limit: limit ?? 25,
    };

    const listResult = await this.memoryService.list(listOptions);
    if (!listResult.ok) {
      return this.errorResult(callId, listResult.error.message);
    }

    const normalizedQuery = query.toLowerCase();
    const matches = listResult.value.filter((record) => {
      return (
        record.content.toLowerCase().includes(normalizedQuery) ||
        record.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery)) ||
        record.entities.some((entity) => entity.toLowerCase().includes(normalizedQuery))
      );
    });

    return this.successResult(callId, {
      action: "recall",
      query,
      results: matches.map((record) => this.toResultRecord(record)),
      count: matches.length,
    });
  }

  private toResultRecord(record: MemoryRecord): MemoryResultRecord {
    return {
      id: record.id,
      content: record.content,
      type: record.type,
      layer: record.layer,
      tags: record.tags,
      entities: record.entities,
      importance: record.importance,
      confidence: record.confidence,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
      accessedAt: record.accessedAt.toISOString(),
    };
  }

  private normalizeAction(value: unknown): MemoryAction | null {
    const action = this.readString(value);
    if (!action) {
      return null;
    }

    if (action === "remember" || action === "recall") {
      return action;
    }

    return null;
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

  private requireString(value: unknown, message: string): string {
    const read = this.readString(value);
    if (!read) {
      throw new Error(message);
    }
    return read;
  }

  private optionalStringArray(value: unknown, message: string): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (!Array.isArray(value)) {
      throw new Error(message);
    }

    const normalized: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") {
        throw new Error(message);
      }

      const trimmed = item.trim();
      if (trimmed.length === 0) {
        throw new Error(message);
      }

      normalized.push(trimmed);
    }

    return normalized;
  }

  private optionalPositiveInteger(value: unknown, message: string): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(message);
    }

    return value;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Memory tool execution failed.";
  }
}
