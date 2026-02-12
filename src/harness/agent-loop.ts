import type { ToolCall, ToolContext } from "../types";
import type { TypedEventBus } from "./event-bus";
import type { HarnessEventMap } from "./events";
import { DoomLoopGuard } from "./doom-loop-guard";
import { PermissionChecker } from "./permissions";
import type { ToolPipeline, ToolPipelineResult } from "./tool-pipeline";

const DEFAULT_MAX_STEPS = 25;
const STEP_LIMIT_MESSAGE = "Step limit reached. Tools are now disabled. Please provide a final response.";
const ABORTED_MESSAGE = "Agent loop aborted";

export interface AgentLoopOptions {
  maxSteps?: number;
  eventBus?: TypedEventBus<HarnessEventMap>;
  toolPipeline?: ToolPipeline;
  permissionChecker?: PermissionChecker;
  doomLoopGuard?: DoomLoopGuard;
  signal?: AbortSignal;
}

export interface StepResult {
  type: "text" | "tool_calls" | "error";
  content?: string;
  toolCalls?: ToolCall[];
  error?: Error;
  done?: boolean;
}

export type StepFunction = (
  messages: AgentMessage[],
  options: { signal?: AbortSignal; toolsDisabled?: boolean },
) => Promise<StepResult>;

export interface AgentMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolPipelineResult[];
}

export interface DelegationContract {
  canDelegate: boolean;
  delegate?: (task: string, context: unknown) => Promise<StepResult>;
}

export interface AgentLoopResult {
  messages: AgentMessage[];
  stepsUsed: number;
  limitReached: boolean;
  aborted: boolean;
}

export class AgentLoop {
  private readonly maxSteps: number;

  constructor(private readonly options: AgentLoopOptions = {}) {
    this.maxSteps = this.resolveMaxSteps(options.maxSteps);
  }

  async run(
    initialMessages: AgentMessage[],
    stepFn: StepFunction,
    context: ToolContext,
    delegation?: DelegationContract,
  ): Promise<AgentLoopResult> {
    const messages = initialMessages.map((message) => ({ ...message }));
    let stepsUsed = 0;
    let limitReached = false;

    while (true) {
      if (this.isAborted()) {
        await this.emitAborted();
        return { messages, stepsUsed, limitReached, aborted: true };
      }

      const stepResult = await stepFn(messages, {
        signal: this.options.signal,
        toolsDisabled: false,
      });

      if (this.isAborted()) {
        await this.emitAborted();
        return { messages, stepsUsed, limitReached, aborted: true };
      }

      if (stepResult.type === "error") {
        await this.emitError(stepResult.error ?? new Error("Step function returned error"));

        const errorMessage = stepResult.error?.message ?? stepResult.content ?? "Step function failed";
        messages.push({ role: "assistant", content: errorMessage });
        return { messages, stepsUsed, limitReached, aborted: false };
      }

      const toolCalls = stepResult.toolCalls ?? [];
      const hasToolCalls = stepResult.type === "tool_calls" && toolCalls.length > 0;

      if (!hasToolCalls) {
        const textContent = stepResult.content ?? "";
        if (textContent.length > 0 || stepResult.type === "text") {
          messages.push({ role: "assistant", content: textContent });
        }

        return { messages, stepsUsed, limitReached, aborted: false };
      }

      messages.push({
        role: "assistant",
        content: stepResult.content ?? "",
        toolCalls,
      });

      if (stepsUsed >= this.maxSteps) {
        limitReached = true;
        const completionMessage = await this.forceTextOnlyCompletion(messages, stepFn);
        messages.push({ role: "assistant", content: completionMessage });
        return { messages, stepsUsed, limitReached, aborted: false };
      }

      stepsUsed += 1;
      this.options.doomLoopGuard?.resetTurn();

      const toolResults = await this.executeToolCalls(toolCalls, context, messages, delegation);
      messages.push({
        role: "tool",
        content: this.serializeToolResults(toolResults),
        toolResults,
      });

      if (this.options.doomLoopGuard?.shouldEscalate()) {
        const escalationMessage = await this.forceTextOnlyCompletion(messages, stepFn);
        messages.push({ role: "assistant", content: escalationMessage });
        return { messages, stepsUsed, limitReached, aborted: false };
      }
    }
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    context: ToolContext,
    messages: AgentMessage[],
    delegation?: DelegationContract,
  ): Promise<ToolPipelineResult[]> {
    const results: ToolPipelineResult[] = [];

    for (const toolCall of toolCalls) {
      if (this.isDelegationToolCall(toolCall, delegation)) {
        const delegatedResult = await this.executeDelegation(toolCall, messages, context, delegation);
        this.recordGuardOutcome(toolCall.name, delegatedResult);
        results.push(delegatedResult);
        continue;
      }

      const allowed = await this.isToolAllowed(toolCall);
      if (!allowed) {
        const deniedResult = this.createErrorResult(toolCall, `Permission denied for tool: ${toolCall.name}`);
        this.recordGuardOutcome(toolCall.name, deniedResult);
        results.push(deniedResult);
        continue;
      }

      if (!this.options.toolPipeline) {
        const missingPipelineResult = this.createErrorResult(toolCall, "Tool pipeline is not configured");
        this.recordGuardOutcome(toolCall.name, missingPipelineResult);
        results.push(missingPipelineResult);
        continue;
      }

      const pipelineResult = await this.options.toolPipeline.execute(toolCall, context);
      this.recordGuardOutcome(toolCall.name, pipelineResult);
      results.push(pipelineResult);
    }

    return results;
  }

  private async executeDelegation(
    toolCall: ToolCall,
    messages: AgentMessage[],
    context: ToolContext,
    delegation?: DelegationContract,
  ): Promise<ToolPipelineResult> {
    if (!delegation?.delegate) {
      return this.createErrorResult(toolCall, "Delegation requested but delegate handler is not configured");
    }

    try {
      const delegationTask = this.extractDelegationTask(toolCall);
      const delegated = await delegation.delegate(delegationTask, {
        toolCall,
        messages,
        context,
      });

      if (delegated.type === "error") {
        return this.createErrorResult(toolCall, delegated.error?.message ?? "Delegation failed");
      }

      if (delegated.type === "tool_calls") {
        return this.createErrorResult(
          toolCall,
          "Delegation returned tool calls; nested delegated tool execution is not supported",
        );
      }

      return {
        status: "success",
        output: delegated.content ?? "",
        metadata: {
          callId: toolCall.id,
          name: toolCall.name,
          durationMs: 0,
          truncated: false,
        },
      };
    } catch (error) {
      return this.createErrorResult(toolCall, this.toErrorMessage(error));
    }
  }

  private isDelegationToolCall(toolCall: ToolCall, delegation?: DelegationContract): boolean {
    return Boolean(delegation?.canDelegate && toolCall.name === "delegate" && delegation.delegate);
  }

  private extractDelegationTask(toolCall: ToolCall): string {
    const task = toolCall.arguments["task"];
    if (typeof task === "string" && task.trim().length > 0) {
      return task;
    }

    return "delegated-task";
  }

  private async isToolAllowed(toolCall: ToolCall): Promise<boolean> {
    if (!this.options.permissionChecker) {
      return true;
    }

    return await this.options.permissionChecker.requestPermission(toolCall);
  }

  private recordGuardOutcome(toolName: string, result: ToolPipelineResult): void {
    if (!this.options.doomLoopGuard) {
      return;
    }

    if (result.status === "error") {
      this.options.doomLoopGuard.recordFailure(toolName);
      return;
    }

    this.options.doomLoopGuard.recordSuccess(toolName);
  }

  private createErrorResult(toolCall: ToolCall, errorMessage: string): ToolPipelineResult {
    return {
      status: "error",
      output: errorMessage,
      metadata: {
        callId: toolCall.id,
        name: toolCall.name,
        durationMs: 0,
        truncated: false,
      },
    };
  }

  private async forceTextOnlyCompletion(messages: AgentMessage[], stepFn: StepFunction): Promise<string> {
    if (this.isAborted()) {
      return ABORTED_MESSAGE;
    }

    try {
      const forcedResult = await stepFn(messages, {
        signal: this.options.signal,
        toolsDisabled: true,
      });

      if (forcedResult.type === "text") {
        if (typeof forcedResult.content === "string" && forcedResult.content.trim().length > 0) {
          return forcedResult.content;
        }
        return STEP_LIMIT_MESSAGE;
      }

      if (forcedResult.type === "error") {
        await this.emitError(forcedResult.error ?? new Error("Forced text completion failed"));
      }

      return STEP_LIMIT_MESSAGE;
    } catch (error) {
      await this.emitError(new Error(this.toErrorMessage(error)));
      return STEP_LIMIT_MESSAGE;
    }
  }

  private serializeToolResults(results: ToolPipelineResult[]): string {
    try {
      return JSON.stringify(results);
    } catch {
      return "[]";
    }
  }

  private async emitError(error: Error): Promise<void> {
    if (!this.options.eventBus) {
      return;
    }

    await this.options.eventBus.emit("error", {
      error,
      retryable: false,
    });
  }

  private async emitAborted(): Promise<void> {
    if (!this.options.eventBus) {
      return;
    }

    await this.options.eventBus.emit("aborted", {
      initiatedBy: "system",
      reason: ABORTED_MESSAGE,
    });
  }

  private isAborted(): boolean {
    return Boolean(this.options.signal?.aborted);
  }

  private resolveMaxSteps(value: number | undefined): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return DEFAULT_MAX_STEPS;
    }

    return Math.max(0, Math.floor(value));
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Unknown error";
  }
}
