import type { MemoryService, MemoryListOptions } from "../memory/services/memory-service";
import type { MemoryRecord } from "../memory/types/memory-record";
import type { MemoryType } from "../memory/types/memory-types";
import type { MemoryEvent, OnMemoryEvent } from "../memory/types/memory-events";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";

type MemoryAction = "remember" | "recall" | "update" | "delete" | "list";

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

export interface MemoryToolOptions {
  onMemoryEvent?: OnMemoryEvent;
}

export class MemoryTool implements Tool {
  definition: ToolDefinition = {
    name: "memory",
    description:
      "Remember, recall, update, delete, and list user memories for full transparency and continuity across conversations.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["remember", "recall", "update", "delete", "list"],
        },
        content: {
          type: "string",
          description: "Memory content to persist when action is remember, or updated content for update action.",
        },
        tags: {
          type: "array",
          description: "Optional tags to attach to remembered content or updated tags for update action.",
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
          description: "Maximum number of results to return for recall or list actions.",
        },
        id: {
          type: "string",
          description: "Memory ID for update and delete actions.",
        },
        importance: {
          type: "number",
          description: "Updated importance score (0-1) for update action.",
        },
        type: {
          type: "string",
          description: "Memory type filter for list action.",
          enum: [
            "fact",
            "preference",
            "decision",
            "episode",
            "skill",
            "entity",
            "document_chunk",
          ],
        },
      },
      required: ["action"],
    },
  };

  constructor(
    private readonly memoryService: MemoryService,
    private readonly options: MemoryToolOptions = {},
  ) {}

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
        case "update":
          return await this.update(callId, args);
        case "delete":
          return await this.delete(callId, args);
        case "list":
          return await this.list(callId, args);
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

    this.emitEvent({ type: "created", record: result.value, timestamp: new Date() });

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

  private async update(callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const id = this.requireString(args.id, "'id' is required for update action.");

    const content = this.readString(args.content) ?? undefined;
    const tags = args.tags !== undefined
      ? this.optionalStringArray(args.tags, "'tags' must be an array of non-empty strings.")
      : undefined;
    const importance = args.importance !== undefined
      ? this.optionalScore(args.importance, "'importance' must be a number between 0 and 1.")
      : undefined;

    if (content === undefined && tags === undefined && importance === undefined) {
      return this.errorResult(
        callId,
        "At least one of 'content', 'tags', or 'importance' is required for update action.",
      );
    }

    const result = await this.memoryService.update(id, { content, tags, importance });
    if (!result.ok) {
      return this.errorResult(callId, result.error.message);
    }

    this.emitEvent({ type: "updated", record: result.value, timestamp: new Date() });

    return this.successResult(callId, {
      action: "update",
      memory: this.toResultRecord(result.value),
    });
  }

  private async delete(callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const id = this.requireString(args.id, "'id' is required for delete action.");

    const getResult = await this.memoryService.getById(id);
    const record = getResult.ok ? getResult.value : null;

    const result = await this.memoryService.forget(id);
    if (!result.ok) {
      return this.errorResult(callId, result.error.message);
    }

    if (record !== null) {
      this.emitEvent({ type: "deleted", record, timestamp: new Date() });
    }

    return this.successResult(callId, { action: "delete", id });
  }

  private async list(callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const typeFilter = this.readString(args.type) ?? undefined;
    const limit = this.optionalPositiveInteger(args.limit, "'limit' must be a positive integer.");

    const options: MemoryListOptions = {
      limit: limit ?? 50,
      ...(typeFilter !== undefined && { type: typeFilter as MemoryType }),
    };

    const result = await this.memoryService.list(options);
    if (!result.ok) {
      return this.errorResult(callId, result.error.message);
    }

    return this.successResult(callId, {
      action: "list",
      memories: result.value.map((r) => this.toResultRecord(r)),
      count: result.value.length,
    });
  }

  private emitEvent(event: MemoryEvent): void {
    if (this.options.onMemoryEvent) {
      this.options.onMemoryEvent(event);
    }
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

    if (
      action === "remember" ||
      action === "recall" ||
      action === "update" ||
      action === "delete" ||
      action === "list"
    ) {
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

  private optionalScore(value: unknown, message: string): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
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
