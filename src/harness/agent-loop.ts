import type { ContentBlock, Message, Provider, ToolCall, ToolContext, ToolResult, TokenUsage } from "../types";
import type { ToolDefinition } from "../types";
import type { ThinkingLevel } from "../types/provider";
import type { ConversationContext } from "../memory/proactive/nudge-engine";
import type { NudgeInjector } from "../memory/proactive/nudge-injector";
import type { TypedEventBus } from "./event-bus";
import type { HarnessEventMap } from "./events";
import { DoomLoopGuard } from "./doom-loop-guard";
import { PermissionChecker } from "./permissions";
import type { ToolPipeline, ToolPipelineResult } from "./tool-pipeline";
import type { ToolExecutor } from "../tools";
import type { AgentLoopFactory } from "./sub-agent-pool";

const DEFAULT_MAX_STEPS = 25;
const STEP_LIMIT_MESSAGE = "Step limit reached. Tools are now disabled. Please provide a final response.";
const ABORTED_MESSAGE = "Agent loop aborted";

export type LoopTerminationReason =
  | "text_only_response"
  | "max_steps_reached"
  | "doom_loop_detected"
  | "aborted"
  | "error";

export interface AgentLoopOptions {
  maxSteps?: number;
  eventBus?: TypedEventBus<HarnessEventMap>;
  toolPipeline?: ToolPipeline;
  permissionChecker?: PermissionChecker;
  doomLoopGuard?: DoomLoopGuard;
  signal?: AbortSignal;
  nudgeInjector?: NudgeInjector;
  agentLoopFactory?: AgentLoopFactory;
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
  delegate?: (task: string, context: DelegationContext) => Promise<StepResult>;
}

export interface DelegationContext {
  toolCall: ToolCall;
  messages: AgentMessage[];
  context: ToolContext;
}

export function createSubAgentPoolDelegationContract(options: {
  canDelegate?: boolean;
  signal?: AbortSignal;
  agentLoopFactory?: AgentLoopFactory;
} = {}): DelegationContract {
  return {
    canDelegate: options.canDelegate ?? true,
    delegate: async (task, _context): Promise<StepResult> => {
      const { SubAgentPool } = await import("./sub-agent-pool");
      const pool = new SubAgentPool({
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.agentLoopFactory ? { agentLoopFactory: options.agentLoopFactory } : {}),
      });
      const [result] = await pool.runAll([{ id: "delegated", prompt: task }]);

      return {
        type: "text",
        content: result?.output ?? result?.error?.message ?? "",
      };
    },
  };
}

export interface AgentLoopResult {
  messages: AgentMessage[];
  stepsUsed: number;
  limitReached: boolean;
  aborted: boolean;
  terminationReason: LoopTerminationReason;
}

export interface ProviderLoopOptions {
  provider: Provider;
  model: string;
  messages: Message[];
  thinkingLevel?: ThinkingLevel;
  toolExecutor: ToolExecutor;
  toolContext: ToolContext;
  tools?: ToolDefinition[];
  systemPrompt?: string;
  abortSignal?: AbortSignal;
}

export type LoopEvent =
  | { type: "token"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool_call_start"; toolCall: ToolCall }
  | { type: "tool_call_end"; result: ToolResult }
  | {
      type: "done";
      usage?: TokenUsage;
      finishReason: string;
      terminationReason: LoopTerminationReason;
      content: string | ContentBlock[];
      limitReached: boolean;
      stepsUsed: number;
    }
  | { type: "error"; error: Error };

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
    this.options.doomLoopGuard?.reset();

    while (true) {
      if (this.isAborted()) {
        await this.emitAborted();
        return {
          messages,
          stepsUsed,
          limitReached,
          aborted: true,
          terminationReason: "aborted",
        };
      }

      const stepResult = await stepFn(messages, {
        signal: this.options.signal,
        toolsDisabled: false,
      });

      if (this.isAborted()) {
        await this.emitAborted();
        return {
          messages,
          stepsUsed,
          limitReached,
          aborted: true,
          terminationReason: "aborted",
        };
      }

      if (stepResult.type === "error") {
        await this.emitError(stepResult.error ?? new Error("Step function returned error"));

        const errorMessage = stepResult.error?.message ?? stepResult.content ?? "Step function failed";
        messages.push({ role: "assistant", content: errorMessage });
        return {
          messages,
          stepsUsed,
          limitReached,
          aborted: false,
          terminationReason: "error",
        };
      }

      const toolCalls = stepResult.toolCalls ?? [];
      const hasToolCalls = stepResult.type === "tool_calls" && toolCalls.length > 0;

      if (!hasToolCalls) {
        const textContent = stepResult.content ?? "";
        if (textContent.length > 0 || stepResult.type === "text") {
          messages.push({ role: "assistant", content: textContent });
        }

        return {
          messages,
          stepsUsed,
          limitReached,
          aborted: false,
          terminationReason: "text_only_response",
        };
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
        return {
          messages,
          stepsUsed,
          limitReached,
          aborted: false,
          terminationReason: "max_steps_reached",
        };
      }

      stepsUsed += 1;
      this.options.doomLoopGuard?.track(toolCalls);

      if (this.options.doomLoopGuard?.shouldEscalate()) {
        limitReached = true;
        const escalationMessage = await this.forceTextOnlyCompletion(messages, stepFn);
        messages.push({ role: "assistant", content: escalationMessage });
        return {
          messages,
          stepsUsed,
          limitReached,
          aborted: false,
          terminationReason: "doom_loop_detected",
        };
      }

      const toolResults = await this.executeToolCalls(toolCalls, context, messages, delegation);
      messages.push({
        role: "tool",
        content: this.serializeToolResults(toolResults),
        toolResults,
      });
    }
  }

  async *runWithProvider(options: ProviderLoopOptions): AsyncIterable<LoopEvent> {
    const loopSignal = options.abortSignal ?? this.options.signal;
    const messages = options.messages.map((message) => ({
      ...message,
      content: cloneContentBlocks(message.content),
    }));

    const accumulatedBlocks: ContentBlock[] = [];
    let stepsUsed = 0;
    this.options.doomLoopGuard?.reset();

    while (true) {
      if (this.isAbortedSignal(loopSignal)) {
        yield {
          type: "done",
          finishReason: "aborted",
          terminationReason: "aborted",
          content: finalizeLoopContent(accumulatedBlocks),
          limitReached: false,
          stepsUsed,
        };
        return;
      }

      const stepRequest = {
        model: options.model,
        messages,
        tools: options.tools,
        systemPrompt: await this.resolveSystemPrompt(options.systemPrompt, messages),
        thinkingLevel: options.thinkingLevel,
        signal: loopSignal,
      };

      const toolCalls: ToolCall[] = [];
      let textOutput = "";
      let finishReason = "stop";
      let usage: TokenUsage | undefined;

      for await (const event of options.provider.stream(stepRequest)) {
        if (this.isAbortedSignal(loopSignal)) {
          break;
        }

        if (event.type === "token") {
          textOutput += event.content;
          yield {
            type: "token",
            content: event.content,
          };
          continue;
        }

        if (event.type === "thinking") {
          yield {
            type: "thinking",
            content: event.content,
          };
          continue;
        }

        if (event.type === "tool_call_start") {
          toolCalls.push(event.toolCall);
          continue;
        }

        if (event.type === "error") {
          yield {
            type: "error",
            error: event.error,
          };
          return;
        }

        if (event.type === "done") {
          finishReason = event.finishReason;
          usage = event.usage;
        }
      }

      if (this.isAbortedSignal(loopSignal)) {
        yield {
          type: "done",
          usage,
          finishReason: "aborted",
          terminationReason: "aborted",
          content: finalizeLoopContent(accumulatedBlocks),
          limitReached: false,
          stepsUsed,
        };
        return;
      }

      if (textOutput.length > 0) {
        accumulatedBlocks.push({ type: "text", text: textOutput });
      }

      const hasToolCalls = toolCalls.length > 0;
      if (!hasToolCalls || finishReason !== "tool_use") {
        yield {
          type: "done",
          usage,
          finishReason,
          terminationReason: "text_only_response",
          content: finalizeLoopContent(accumulatedBlocks),
          limitReached: false,
          stepsUsed,
        };
        return;
      }

      const assistantToolUseBlocks: ContentBlock[] = toolCalls.map((toolCall) => ({
        type: "tool_use",
        id: toolCall.id,
        name: toolCall.name,
        input: toolCall.arguments,
      }));

      accumulatedBlocks.push(...assistantToolUseBlocks);
      messages.push(createAssistantMessage([...assistantToolUseBlocks]));

      if (stepsUsed >= this.maxSteps) {
        yield {
          type: "done",
          usage,
          finishReason: "step_limit",
          terminationReason: "max_steps_reached",
          content: finalizeLoopContent(accumulatedBlocks),
          limitReached: true,
          stepsUsed,
        };
        return;
      }

      stepsUsed += 1;

      this.options.doomLoopGuard?.track(toolCalls);
      if (this.options.doomLoopGuard?.shouldEscalate()) {
        yield {
          type: "done",
          usage,
          finishReason: "doom_loop",
          terminationReason: "doom_loop_detected",
          content: finalizeLoopContent(accumulatedBlocks),
          limitReached: true,
          stepsUsed,
        };
        return;
      }

      if (this.isAbortedSignal(loopSignal)) {
        yield {
          type: "done",
          usage,
          finishReason: "aborted",
          terminationReason: "aborted",
          content: finalizeLoopContent(accumulatedBlocks),
          limitReached: false,
          stepsUsed,
        };
        return;
      }

      const executionContext: ToolContext = {
        ...options.toolContext,
        abortSignal: options.toolContext.abortSignal ?? loopSignal,
      };

      const toolResults: ToolResult[] = [];
      if (!executionContext.abortSignal) {
        for (const toolCall of toolCalls) {
          yield {
            type: "tool_call_start",
            toolCall,
          };
        }

        toolResults.push(
          ...(await options.toolExecutor.executeMany(toolCalls, executionContext, {
            abortSignal: loopSignal,
          })),
        );
      } else {
        for (const toolCall of toolCalls) {
          if (executionContext.abortSignal.aborted) {
            break;
          }

          yield {
            type: "tool_call_start",
            toolCall,
          };

          toolResults.push(
            await options.toolExecutor.execute(toolCall, executionContext, {
              abortSignal: executionContext.abortSignal,
            }),
          );

          if (executionContext.abortSignal.aborted) {
            break;
          }
        }
      }
      const toolResultBlocks: ContentBlock[] = [];

      for (const toolResult of toolResults) {
        yield {
          type: "tool_call_end",
          result: toolResult,
        };

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: toolResult.callId,
          content: serializeToolResult(toolResult),
          ...(toolResult.error ? { is_error: true } : {}),
        });
      }

      accumulatedBlocks.push(...toolResultBlocks);
      messages.push(createUserMessage(toolResultBlocks));

      if (this.isAbortedSignal(loopSignal)) {
        yield {
          type: "done",
          usage,
          finishReason: "aborted",
          terminationReason: "aborted",
          content: finalizeLoopContent(accumulatedBlocks),
          limitReached: false,
          stepsUsed,
        };
        return;
      }
    }
  }

  private async executeToolCalls(
    toolCalls: ToolCall[],
    context: ToolContext,
    messages: AgentMessage[],
    delegation?: DelegationContract,
  ): Promise<ToolPipelineResult[]> {
    const results: Array<ToolPipelineResult | undefined> = Array.from({ length: toolCalls.length });
    const executableCalls: ToolCall[] = [];
    const executableIndices: number[] = [];

    for (const [index, toolCall] of toolCalls.entries()) {
      if (this.isDelegationToolCall(toolCall, delegation)) {
        const delegatedResult = await this.executeDelegation(toolCall, messages, context, delegation);
        results[index] = delegatedResult;
        continue;
      }

      const allowed = await this.isToolAllowed(toolCall);
      if (!allowed) {
        const deniedResult = this.createErrorResult(toolCall, `Permission denied for tool: ${toolCall.name}`);
        results[index] = deniedResult;
        continue;
      }

      if (!this.options.toolPipeline) {
        const missingPipelineResult = this.createErrorResult(toolCall, "Tool pipeline is not configured");
        results[index] = missingPipelineResult;
        continue;
      }

      executableCalls.push(toolCall);
      executableIndices.push(index);
    }

    if (executableCalls.length > 0 && this.options.toolPipeline) {
      const pipelineResults = await this.options.toolPipeline.executeMany(executableCalls, context);
      for (const [resultIndex, pipelineResult] of pipelineResults.entries()) {
        const originalIndex = executableIndices[resultIndex];
        if (originalIndex === undefined) {
          continue;
        }

        results[originalIndex] = pipelineResult;
      }
    }

    for (const [index, toolCall] of toolCalls.entries()) {
      if (results[index]) {
        this.recordGuardOutcome(toolCall.name, results[index]);
        continue;
      }

      const fallbackResult = this.createErrorResult(toolCall, "Tool execution failed");
      this.recordGuardOutcome(toolCall.name, fallbackResult);
      results[index] = fallbackResult;
    }

    return results as ToolPipelineResult[];
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

  private isAbortedSignal(signal?: AbortSignal): boolean {
    return Boolean(signal?.aborted);
  }

  private async resolveSystemPrompt(
    baseSystemPrompt: string | undefined,
    messages: Message[],
  ): Promise<string | undefined> {
    const nudgeInjector = this.options.nudgeInjector;
    if (!nudgeInjector) {
      return baseSystemPrompt;
    }

    const conversationContext = this.buildConversationContext(messages);
    try {
      return await nudgeInjector.injectNudges(conversationContext, baseSystemPrompt ?? "");
    } catch {
      return baseSystemPrompt;
    }
  }

  private buildConversationContext(messages: Message[]): ConversationContext {
    const userMessages = messages
      .filter((message) => message.role === "user")
      .map((message) => extractMessageText(message.content).trim())
      .filter((content) => content.length > 0);

    const latestUserQuery = userMessages[userMessages.length - 1] ?? "";
    const recentTopics = userMessages.slice(-3);

    return {
      query: latestUserQuery,
      conversationId: "agent-loop",
      recentTopics,
    };
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

function createAssistantMessage(content: ContentBlock[]): Message {
  return {
    id: crypto.randomUUID(),
    role: "assistant",
    content,
    createdAt: new Date(),
  };
}

function createUserMessage(content: ContentBlock[]): Message {
  return {
    id: crypto.randomUUID(),
    role: "user",
    content,
    createdAt: new Date(),
  };
}

function serializeToolResult(result: ToolResult): string {
  if (typeof result.error === "string" && result.error.length > 0) {
    return result.error;
  }

  if (typeof result.result === "string") {
    return result.result;
  }

  try {
    return JSON.stringify(result.result);
  } catch {
    return String(result.result);
  }
}

function finalizeLoopContent(blocks: ContentBlock[]): string | ContentBlock[] {
  if (blocks.length === 0) {
    return "";
  }

  const hasNonText = blocks.some((block) => block.type !== "text");
  if (!hasNonText) {
    return blocks
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
  }

  return blocks;
}

function cloneContentBlocks(content: Message["content"]): Message["content"] {
  if (typeof content === "string") {
    return content;
  }

  return content.map((block) => ({ ...block }));
}

function extractMessageText(content: Message["content"]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }

      if (block.type === "tool_result") {
        return block.content;
      }

      return "";
    })
    .join("\n")
    .trim();
}
