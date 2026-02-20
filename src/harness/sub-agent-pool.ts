import { AgentLoop, type AgentLoopOptions, type LoopTerminationReason, type StepResult } from "./agent-loop";
import { DoomLoopGuard } from "./doom-loop-guard";
import type { TypedEventBus } from "./event-bus";
import { createHarnessEventBus } from "./event-bus";
import type { HarnessEventMap, HarnessEventType } from "./events";
import type { ToolContext, ToolDefinition } from "../types";

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_USER_ID = "sub-agent-pool";
const DEFAULT_WORKSPACE_ID = "sub-agent-pool";
const ABORT_ERROR_MESSAGE = "Sub-agent task aborted";

export type WorkspaceTier = "free" | "pro" | "team";

export const TIER_CONCURRENCY_LIMITS: Record<WorkspaceTier, number> = {
  free: 2,
  pro: 5,
  team: 15,
} as const;

export interface SubAgentTask {
  id: string;
  prompt: string;
  tools?: ToolDefinition[];
  maxSteps?: number;
}

export interface SubAgentResult {
  id: string;
  output?: string;
  error?: Error;
  stepsUsed: number;
  terminationReason: LoopTerminationReason;
}

export interface AgentLoopRunResult {
  output: string;
  stepsUsed: number;
  terminationReason: LoopTerminationReason;
}

export interface AgentLoopRunner {
  runTask(task: SubAgentTask, signal: AbortSignal): Promise<AgentLoopRunResult>;
}

export type AgentLoopFactory = (options: AgentLoopOptions) => AgentLoopRunner;

export type AgentStatus = "queued" | "running" | "done" | "failed";

export interface AgentState {
  id: string;
  status: AgentStatus;
  stepsUsed: number;
  prompt: string;
  startedAt?: Date;
  completedAt?: Date;
}

export interface SubAgentPoolOptions {
  maxConcurrent?: number;
  tier?: WorkspaceTier;
  signal?: AbortSignal;
  agentLoopFactory?: AgentLoopFactory;
  eventBus?: TypedEventBus<HarnessEventMap>;
}

class Semaphore {
  private permits: number;
  private readonly queue: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }

    await new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.permits += 1;
    const next = this.queue.shift();
    if (!next) {
      return;
    }

    this.permits -= 1;
    next();
  }
}

const PROMPT_TRUNCATION_LENGTH = 100;

export class SubAgentPool {
  private readonly maxConcurrent: number;
  private readonly signal?: AbortSignal;
  private readonly agentLoopFactory: AgentLoopFactory;
  private readonly eventBus?: TypedEventBus<HarnessEventMap>;
  private readonly agentStates = new Map<string, AgentState>();

  constructor(options: SubAgentPoolOptions = {}) {
    this.maxConcurrent = this.resolveMaxConcurrent(options.maxConcurrent, options.tier);
    this.signal = options.signal;
    this.agentLoopFactory = options.agentLoopFactory ?? createDefaultAgentLoopFactory();
    this.eventBus = options.eventBus;
  }

  getAgentStates(): AgentState[] {
    return Array.from(this.agentStates.values());
  }

  async runAll(tasks: SubAgentTask[]): Promise<SubAgentResult[]> {
    if (tasks.length === 0) {
      return [];
    }

    for (const task of tasks) {
      this.agentStates.set(task.id, {
        id: task.id,
        status: "queued",
        stepsUsed: 0,
        prompt: truncatePrompt(task.prompt),
      });
    }

    const semaphore = new Semaphore(this.maxConcurrent);
    const childControllers = new Map<string, AbortController>();

    for (const task of tasks) {
      const controller = new AbortController();
      if (this.signal?.aborted) {
        controller.abort(this.signal.reason);
      }
      childControllers.set(task.id, controller);
    }

    const abortChildren = () => {
      for (const controller of childControllers.values()) {
        if (!controller.signal.aborted) {
          controller.abort(this.signal?.reason);
        }
      }
    };

    if (this.signal) {
      this.signal.addEventListener("abort", abortChildren, { once: true });
    }

    const runPromises = tasks.map(async (task) => {
      const childController = childControllers.get(task.id);
      if (!childController) {
        this.updateAgentState(task.id, "failed");
        return this.createFailureResult(task.id, new Error(`Missing child controller for task ${task.id}`), false);
      }

      await semaphore.acquire();
      try {
        if (childController.signal.aborted) {
          this.updateAgentState(task.id, "failed");
          return this.createFailureResult(task.id, createAbortError(), true);
        }

        this.updateAgentState(task.id, "running", { startedAt: new Date() });

        const childEventBus = this.eventBus ? createHarnessEventBus() : undefined;
        const cleanupForwarder = childEventBus
          ? this.forwardChildEvents(task.id, childEventBus)
          : undefined;

        const doomLoopGuard = new DoomLoopGuard();
        const loopRunner = this.agentLoopFactory({
          maxSteps: task.maxSteps,
          signal: childController.signal,
          doomLoopGuard,
          eventBus: childEventBus,
        });

        const runResult = await loopRunner.runTask(task, childController.signal);
        cleanupForwarder?.();

        this.updateAgentState(task.id, "done", {
          stepsUsed: runResult.stepsUsed,
          completedAt: new Date(),
        });

        return {
          id: task.id,
          output: runResult.output,
          stepsUsed: runResult.stepsUsed,
          terminationReason: runResult.terminationReason,
        } satisfies SubAgentResult;
      } catch (error) {
        this.updateAgentState(task.id, "failed", { completedAt: new Date() });
        return this.createFailureResult(task.id, normalizeError(error), childController.signal.aborted);
      } finally {
        semaphore.release();
      }
    });

    const settled = await Promise.allSettled(runPromises);

    if (this.signal) {
      this.signal.removeEventListener("abort", abortChildren);
    }

    return settled.map((entry, index) => {
      if (entry.status === "fulfilled") {
        return entry.value;
      }

      const task = tasks[index];
      const taskId = task?.id ?? `unknown-${index}`;
      return this.createFailureResult(taskId, normalizeError(entry.reason), false);
    });
  }

  private createFailureResult(taskId: string, error: Error, aborted: boolean): SubAgentResult {
    return {
      id: taskId,
      error,
      stepsUsed: 0,
      terminationReason: aborted ? "aborted" : "error",
    };
  }

  private updateAgentState(
    taskId: string,
    status: AgentStatus,
    updates?: Partial<Pick<AgentState, "stepsUsed" | "startedAt" | "completedAt">>,
  ): void {
    const existing = this.agentStates.get(taskId);
    if (!existing) {
      return;
    }

    this.agentStates.set(taskId, {
      ...existing,
      status,
      ...updates,
    });
  }

  private forwardChildEvents(
    childId: string,
    childEventBus: TypedEventBus<HarnessEventMap>,
  ): () => void {
    if (!this.eventBus) {
      return () => {};
    }

    const parentBus = this.eventBus;
    const unsubscribers: Array<() => void> = [];

    const eventTypes: HarnessEventType[] = [
      "message_start",
      "token",
      "tool_call_start",
      "tool_call_end",
      "compaction",
      "error",
      "done",
      "permission_request",
      "aborted",
    ];

    for (const eventType of eventTypes) {
      const unsub = childEventBus.on(eventType, (envelope) => {
        void parentBus.emit("child_agent_event", {
          childId,
          eventType: envelope.type,
          payload: envelope.payload,
        });
      });
      unsubscribers.push(unsub);
    }

    return () => {
      for (const unsub of unsubscribers) {
        unsub();
      }
    };
  }

  private resolveMaxConcurrent(value: number | undefined, tier: WorkspaceTier | undefined): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return Math.max(1, Math.floor(value));
    }

    if (tier) {
      return TIER_CONCURRENCY_LIMITS[tier];
    }

    return DEFAULT_MAX_CONCURRENT;
  }
}

function createDefaultAgentLoopFactory(): AgentLoopFactory {
  return (options) => {
    const loop = new AgentLoop(options);
    return {
      async runTask(task, signal): Promise<AgentLoopRunResult> {
        const initialMessages = [{ role: "user" as const, content: task.prompt }];
        const toolContext = createSubAgentToolContext(task.id, signal);
        const result = await loop.run(initialMessages, createDefaultStepFunction(task.prompt), toolContext);
        const output = extractLastAssistantMessage(result.messages);

        return {
          output,
          stepsUsed: result.stepsUsed,
          terminationReason: result.terminationReason,
        };
      },
    };
  };
}

function createDefaultStepFunction(prompt: string): (
  _messages: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string }>,
) => Promise<StepResult> {
  return async () => ({
    type: "text",
    content: prompt,
    done: true,
  });
}

function createSubAgentToolContext(taskId: string, signal: AbortSignal): ToolContext {
  return {
    conversationId: `sub-agent-${taskId}`,
    userId: DEFAULT_USER_ID,
    workspaceId: DEFAULT_WORKSPACE_ID,
    abortSignal: signal,
  };
}

function extractLastAssistantMessage(messages: Array<{ role: "user" | "assistant" | "system" | "tool"; content: string }>): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return message.content;
    }
  }

  return "";
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return new Error(error);
  }

  return new Error("Unknown sub-agent error");
}

function createAbortError(): Error {
  return new Error(ABORT_ERROR_MESSAGE);
}

function truncatePrompt(prompt: string): string {
  if (prompt.length <= PROMPT_TRUNCATION_LENGTH) {
    return prompt;
  }

  return `${prompt.slice(0, PROMPT_TRUNCATION_LENGTH)}...`;
}
