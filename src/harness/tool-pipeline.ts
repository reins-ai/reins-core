import type { ToolExecutor } from "../tools";
import type { ToolCall, ToolContext, ToolResult } from "../types";
import type { TypedEventBus } from "./event-bus";
import type { HarnessEventMap } from "./events";

const DEFAULT_MAX_OUTPUT_LENGTH = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const TRUNCATION_SUFFIX = "...(truncated)";

export interface ToolPipelineOptions {
  executor: ToolExecutor;
  eventBus?: TypedEventBus<HarnessEventMap>;
  maxOutputLength?: number;
  defaultTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface ToolPipelineResult {
  status: "success" | "error" | "truncated";
  output: unknown;
  metadata: {
    callId: string;
    name: string;
    durationMs: number;
    truncated: boolean;
    originalLength?: number;
  };
}

export type BeforeToolHook = (toolCall: ToolCall, context: ToolContext) => void | Promise<void>;
export type AfterToolHook = (
  result: ToolPipelineResult,
  toolCall: ToolCall,
  context: ToolContext,
) => void | Promise<void>;

export class ToolPipeline {
  private readonly beforeHooks: BeforeToolHook[] = [];
  private readonly afterHooks: AfterToolHook[] = [];
  private readonly maxOutputLength: number;
  private readonly defaultTimeoutMs: number;

  public constructor(private readonly options: ToolPipelineOptions) {
    this.maxOutputLength = this.getValidLimit(options.maxOutputLength, DEFAULT_MAX_OUTPUT_LENGTH);
    this.defaultTimeoutMs = this.getValidLimit(options.defaultTimeoutMs, DEFAULT_TIMEOUT_MS);
  }

  public beforeEach(hook: BeforeToolHook): void {
    this.beforeHooks.push(hook);
  }

  public afterEach(hook: AfterToolHook): void {
    this.afterHooks.push(hook);
  }

  public async execute(toolCall: ToolCall, context: ToolContext): Promise<ToolPipelineResult> {
    const startedAt = Date.now();

    try {
      this.throwIfAborted();
      await this.emitToolCallStart(toolCall);
      await this.runBeforeHooks(toolCall, context);

      const toolResult = await this.options.executor.executeWithTimeout(
        toolCall,
        context,
        this.defaultTimeoutMs,
      );
      const pipelineResult = this.normalizeToolResult(toolResult, startedAt);

      await this.runAfterHooks(pipelineResult, toolCall, context);
      await this.emitToolCallEnd(pipelineResult);

      return pipelineResult;
    } catch (error) {
      const pipelineResult = this.createErrorResult(toolCall, startedAt, this.formatError(error));
      await this.runAfterHooks(pipelineResult, toolCall, context);
      await this.emitToolCallEnd(pipelineResult);
      return pipelineResult;
    }
  }

  public async executeBatch(toolCalls: ToolCall[], context: ToolContext): Promise<ToolPipelineResult[]> {
    const settledResults = await Promise.allSettled(
      toolCalls.map((toolCall) => this.execute(toolCall, context)),
    );

    return settledResults.map((settledResult, index) => {
      if (settledResult.status === "fulfilled") {
        return settledResult.value;
      }

      const fallbackToolCall = toolCalls[index] ?? {
        id: "unknown",
        name: "unknown",
        arguments: {},
      };

      return this.createErrorResult(fallbackToolCall, Date.now(), this.formatError(settledResult.reason));
    });
  }

  private async runBeforeHooks(toolCall: ToolCall, context: ToolContext): Promise<void> {
    for (const hook of this.beforeHooks) {
      await hook(toolCall, context);
    }
  }

  private async runAfterHooks(
    result: ToolPipelineResult,
    toolCall: ToolCall,
    context: ToolContext,
  ): Promise<void> {
    for (const hook of this.afterHooks) {
      try {
        await hook(result, toolCall, context);
      } catch {
        // Hook failures are isolated so tracing hooks cannot break tool execution.
      }
    }
  }

  private normalizeToolResult(toolResult: ToolResult, startedAt: number): ToolPipelineResult {
    const durationMs = Date.now() - startedAt;
    const errorMessage = typeof toolResult.error === "string" ? toolResult.error : undefined;

    if (errorMessage) {
      return {
        status: "error",
        output: errorMessage,
        metadata: {
          callId: toolResult.callId,
          name: toolResult.name,
          durationMs,
          truncated: false,
        },
      };
    }

    const truncated = this.truncateOutput(toolResult.result);
    return {
      status: truncated.truncated ? "truncated" : "success",
      output: truncated.output,
      metadata: {
        callId: toolResult.callId,
        name: toolResult.name,
        durationMs,
        truncated: truncated.truncated,
        originalLength: truncated.originalLength,
      },
    };
  }

  private truncateOutput(output: unknown): {
    output: unknown;
    truncated: boolean;
    originalLength?: number;
  } {
    if (this.maxOutputLength <= 0) {
      return { output, truncated: false };
    }

    if (typeof output === "string") {
      if (output.length <= this.maxOutputLength) {
        return { output, truncated: false };
      }

      return {
        output: this.truncateText(output),
        truncated: true,
        originalLength: output.length,
      };
    }

    const serialized = this.serializeOutput(output);
    if (!serialized || serialized.length <= this.maxOutputLength) {
      return { output, truncated: false };
    }

    return {
      output: this.truncateText(serialized),
      truncated: true,
      originalLength: serialized.length,
    };
  }

  private truncateText(value: string): string {
    const maxLengthWithoutSuffix = Math.max(0, this.maxOutputLength - TRUNCATION_SUFFIX.length);
    return `${value.slice(0, maxLengthWithoutSuffix)}${TRUNCATION_SUFFIX}`;
  }

  private serializeOutput(output: unknown): string | null {
    try {
      const serialized = JSON.stringify(output);
      return typeof serialized === "string" ? serialized : null;
    } catch {
      return null;
    }
  }

  private createErrorResult(
    toolCall: ToolCall,
    startedAt: number,
    errorMessage: string,
  ): ToolPipelineResult {
    return {
      status: "error",
      output: errorMessage,
      metadata: {
        callId: toolCall.id,
        name: toolCall.name,
        durationMs: Date.now() - startedAt,
        truncated: false,
      },
    };
  }

  private throwIfAborted(): void {
    if (this.options.signal?.aborted) {
      throw new Error("Tool execution aborted");
    }
  }

  private async emitToolCallStart(toolCall: ToolCall): Promise<void> {
    if (!this.options.eventBus) {
      return;
    }

    await this.options.eventBus.emit("tool_call_start", { toolCall });
  }

  private async emitToolCallEnd(result: ToolPipelineResult): Promise<void> {
    if (!this.options.eventBus) {
      return;
    }

    const eventResult: ToolResult = {
      callId: result.metadata.callId,
      name: result.metadata.name,
      result,
      error: result.status === "error" ? this.formatError(result.output) : undefined,
    };

    await this.options.eventBus.emit("tool_call_end", { result: eventResult });
  }

  private formatError(error: unknown): string {
    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    return "Tool execution failed";
  }

  private getValidLimit(candidate: number | undefined, fallback: number): number {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
      return fallback;
    }

    return Math.max(0, Math.floor(candidate));
  }
}
