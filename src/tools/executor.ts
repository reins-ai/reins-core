import type { ToolCall, ToolContext, ToolResult } from "../types";
import { ToolRegistry } from "./registry";
import {
  SYSTEM_TOOL_ERROR_CODES,
  SystemToolExecutionError,
  toSystemToolError,
  toSystemToolErrorDetail,
} from "./system/types";

export class ToolExecutor {
  constructor(private readonly registry: ToolRegistry) {}

  async execute(
    toolCall: ToolCall,
    context: ToolContext,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ToolResult> {
    const abortSignal = options?.abortSignal ?? context.abortSignal;

    if (abortSignal?.aborted) {
      return this.createErrorResult(toolCall, "Tool execution aborted");
    }

    const tool = this.registry.get(toolCall.name);

    if (!tool) {
      return this.createErrorResult(toolCall, SystemToolExecutionError.toolNotFound(toolCall.name));
    }

    try {
      const executionContext: ToolContext = {
        ...context,
        ...(abortSignal ? { abortSignal } : {}),
      };
      const rawResult = await tool.execute(toolCall.arguments, executionContext);

      if (abortSignal?.aborted && typeof rawResult.error !== "string") {
        return this.createErrorResult(toolCall, "Tool execution aborted");
      }

      return {
        ...rawResult,
        callId: toolCall.id,
        name: toolCall.name,
      };
    } catch (error) {
      return this.createErrorResult(toolCall, error);
    }
  }

  async executeMany(
    toolCalls: ToolCall[],
    context: ToolContext,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ToolResult[]> {
    const abortSignal = options?.abortSignal ?? context.abortSignal;

    if (abortSignal) {
      const results: ToolResult[] = [];
      for (const toolCall of toolCalls) {
        if (abortSignal.aborted) {
          break;
        }

        results.push(await this.execute(toolCall, context, { abortSignal }));
      }
      return results;
    }

    const settledResults = await Promise.allSettled(
      toolCalls.map((toolCall) => this.execute(toolCall, context, { abortSignal })),
    );

    return settledResults.map((settledResult, index) => {
      if (settledResult.status === "fulfilled") {
        return settledResult.value;
      }

      const toolCall = toolCalls[index];
      if (!toolCall) {
        const normalizedError = toSystemToolError(
          settledResult.reason,
          SYSTEM_TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED,
        );
        return {
          callId: "unknown",
          name: "unknown",
          result: null,
          error: normalizedError.message,
          errorDetail: toSystemToolErrorDetail(normalizedError),
        };
      }

      return this.createErrorResult(toolCall, settledResult.reason);
    });
  }

  async executeWithTimeout(
    toolCall: ToolCall,
    context: ToolContext,
    timeoutMs: number,
  ): Promise<ToolResult> {
    if (timeoutMs <= 0) {
      return this.createErrorResult(toolCall, SystemToolExecutionError.timeout(Math.max(0, timeoutMs)));
    }

    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const timeoutPromise = new Promise<ToolResult>((resolve) => {
      timeoutId = setTimeout(() => {
        resolve(this.createErrorResult(toolCall, SystemToolExecutionError.timeout(timeoutMs)));
      }, timeoutMs);
    });

    const result = await Promise.race([this.execute(toolCall, context), timeoutPromise]);

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    return result;
  }

  private createErrorResult(toolCall: ToolCall, error: unknown): ToolResult {
    const normalizedError = toSystemToolError(error, SYSTEM_TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);

    return {
      callId: toolCall.id,
      name: toolCall.name,
      result: null,
      error: normalizedError.message,
      errorDetail: toSystemToolErrorDetail(normalizedError),
    };
  }
}
