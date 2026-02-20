import { SubAgentPool, type AgentLoopFactory, type SubAgentPoolOptions, type SubAgentResult, type SubAgentTask } from "../harness/sub-agent-pool";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";

export type DelegateMergeStrategy = "concat" | "synthesize" | "first";

export interface SubAgentResultMerger {
  merge(results: SubAgentResult[], strategy: DelegateMergeStrategy): Promise<string>;
}

interface SubAgentPoolLike {
  runAll(tasks: SubAgentTask[]): Promise<SubAgentResult[]>;
}

export interface DelegateToolOptions {
  merger?: SubAgentResultMerger;
  poolFactory?: (options: SubAgentPoolOptions) => SubAgentPoolLike;
  agentLoopFactory?: AgentLoopFactory;
}

const DEFAULT_CALL_ID = "delegate-call";
const DEFAULT_TASK_ID_PREFIX = "delegate-task";

class FallbackSubAgentResultMerger implements SubAgentResultMerger {
  async merge(results: SubAgentResult[], strategy: DelegateMergeStrategy): Promise<string> {
    if (strategy === "first") {
      return this.mergeFirst(results);
    }

    return this.mergeConcatenated(results);
  }

  private mergeFirst(results: SubAgentResult[]): string {
    for (const result of results) {
      if (typeof result.output === "string" && result.output.trim().length > 0) {
        return result.output;
      }
    }

    for (const result of results) {
      if (result.error?.message) {
        return result.error.message;
      }
    }

    return "";
  }

  private mergeConcatenated(results: SubAgentResult[]): string {
    const outputs = results
      .map((result) => result.output?.trim() ?? "")
      .filter((output) => output.length > 0);

    if (outputs.length > 0) {
      return outputs.join("\n\n");
    }

    const errors = results
      .map((result) => result.error?.message?.trim() ?? "")
      .filter((errorMessage) => errorMessage.length > 0);

    return errors.join("\n");
  }
}

export class DelegateTool implements Tool {
  readonly definition: ToolDefinition = {
    name: "delegate",
    description: "Run multiple sub-agent tasks in parallel and return merged results",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          description: "List of sub-agent task prompts to execute in parallel.",
          items: {
            type: "string",
          },
        },
        merge_strategy: {
          type: "string",
          description: "How to merge sub-agent results.",
          enum: ["concat", "synthesize", "first"],
        },
        max_concurrent: {
          type: "number",
          description: "Optional max number of concurrent sub-agent tasks.",
        },
      },
      required: ["tasks", "merge_strategy"],
    },
  };

  private readonly merger: SubAgentResultMerger;
  private readonly poolFactory: (options: SubAgentPoolOptions) => SubAgentPoolLike;
  private readonly agentLoopFactory?: AgentLoopFactory;

  constructor(options: DelegateToolOptions = {}) {
    this.merger = options.merger ?? new FallbackSubAgentResultMerger();
    this.poolFactory = options.poolFactory ?? ((poolOptions) => new SubAgentPool(poolOptions));
    this.agentLoopFactory = options.agentLoopFactory;
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const callId = this.readString(args["callId"]) ?? DEFAULT_CALL_ID;

    try {
      const tasks = this.parseTasks(args["tasks"]);
      const mergeStrategy = this.parseMergeStrategy(args["merge_strategy"]);
      const maxConcurrent = this.parseMaxConcurrent(args["max_concurrent"]);

      const pool = this.poolFactory({
        ...(maxConcurrent !== undefined ? { maxConcurrent } : {}),
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        ...(this.agentLoopFactory ? { agentLoopFactory: this.agentLoopFactory } : {}),
      });

      const subAgentTasks: SubAgentTask[] = tasks.map((task, index) => ({
        id: `${DEFAULT_TASK_ID_PREFIX}-${index + 1}`,
        prompt: task,
      }));

      const results = await pool.runAll(subAgentTasks);
      const merged = await this.merger.merge(results, mergeStrategy);

      return {
        callId,
        name: this.definition.name,
        result: merged,
      };
    } catch (error) {
      return {
        callId,
        name: this.definition.name,
        result: null,
        error: this.formatError(error),
      };
    }
  }

  private parseTasks(value: unknown): string[] {
    if (!Array.isArray(value)) {
      throw new Error("'tasks' must be an array of non-empty strings.");
    }

    const tasks = value
      .map((entry) => this.readString(entry))
      .filter((entry): entry is string => typeof entry === "string");

    if (tasks.length === 0) {
      throw new Error("'tasks' must include at least one task.");
    }

    return tasks;
  }

  private parseMergeStrategy(value: unknown): DelegateMergeStrategy {
    if (value === "concat" || value === "synthesize" || value === "first") {
      return value;
    }

    throw new Error("'merge_strategy' must be one of: concat, synthesize, first.");
  }

  private parseMaxConcurrent(value: unknown): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error("'max_concurrent' must be a positive integer when provided.");
    }

    return value;
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

    return "Delegate tool execution failed.";
  }
}
