import type { ToolCall, ToolContext, ToolResult } from "../types";
import { ToolRegistry } from "./registry";

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolResult> {
    const tool = this.registry.get(toolCall.name);

    if (!tool) {
      return this.createErrorResult(toolCall, `Tool not found: ${toolCall.name}`);
    }

    try {
      const rawResult = await tool.execute(toolCall.arguments, context);

      return {
        ...rawResult,
        callId: toolCall.id,
        name: toolCall.name,
      };
    } catch (error) {
      return this.createErrorResult(toolCall, this.formatError(error));
    }
  }

  async executeMany(toolCalls: ToolCall[], context: ToolContext): Promise<ToolResult[]> {
    const settledResults = await Promise.allSettled(
      toolCalls.map((toolCall) => this.execute(toolCall, context)),
    );

    return settledResults.map((settledResult, index) => {
      if (settledResult.status === "fulfilled") {
        return settledResult.value;
      }

      const toolCall = toolCalls[index];
      if (!toolCall) {
        return {
          callId: "unknown",
          name: "unknown",
          result: null,
          error: this.formatError(settledResult.reason),
        };
      }

      return this.createErrorResult(toolCall, this.formatError(settledResult.reason));
    });
  }

  async executeWithTimeout(
    toolCall: ToolCall,
    context: ToolContext,
    timeoutMs: number,
  ): Promise<ToolResult> {
    if (timeoutMs <= 0) {
      return this.createErrorResult(
        toolCall,
        `Tool execution timed out after ${Math.max(0, timeoutMs)}ms`,
      );
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<ToolResult>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve(this.createErrorResult(toolCall, `Tool execution timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });

    const result = await Promise.race([this.execute(toolCall, context), timeoutPromise]);

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    return result;
  }

  private createErrorResult(toolCall: ToolCall, errorMessage: string): ToolResult {
    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: errorMessage,
    };
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Tool execution failed";
  }
}
