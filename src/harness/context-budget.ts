import { estimateTokens } from "../context/tokenizer";
import type { TypedEventBus } from "./event-bus";
import type { HarnessEventMap } from "./events";
import type { AgentMessage } from "./agent-loop";

const DEFAULT_RESERVE_TOKENS = 4_096;
const DEFAULT_MAX_TOOL_OUTPUT_TOKENS = 2_000;
const DEFAULT_KEEP_RECENT_MESSAGES = 10;
const MESSAGE_TOKEN_OVERHEAD = 4;
const OUTPUT_TRUNCATION_SUFFIX = " ...[output truncated]";

const STOP_WORDS = new Set([
  "about",
  "after",
  "also",
  "been",
  "from",
  "into",
  "just",
  "more",
  "only",
  "over",
  "that",
  "than",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "tool",
  "turn",
  "user",
  "with",
]);

export interface ContextBudgetOptions {
  contextWindowTokens: number;
  reserveTokens?: number;
  maxToolOutputTokens?: number;
  keepRecentMessages?: number;
  eventBus?: TypedEventBus<HarnessEventMap>;
}

export interface CompactionAction {
  type: "none" | "prune_tool_outputs" | "summarize_history" | "both";
  removedMessages: number;
  prunedToolOutputs: number;
  summary?: string;
  beforeTokens: number;
  afterTokens: number;
}

interface BudgetCheckResult {
  fits: boolean;
  estimatedTokens: number;
  budgetTokens: number;
}

interface PruneResult {
  messages: AgentMessage[];
  prunedToolOutputs: number;
}

interface SummaryResult {
  messages: AgentMessage[];
  removedMessages: number;
  summary?: string;
}

export class ContextBudget {
  private readonly contextWindowTokens: number;
  private readonly reserveTokens: number;
  private readonly maxToolOutputTokens: number;
  private readonly keepRecentMessages: number;
  private readonly eventBus?: TypedEventBus<HarnessEventMap>;

  constructor(options: ContextBudgetOptions) {
    this.contextWindowTokens = this.normalizePositiveInteger(options.contextWindowTokens, 1);
    this.reserveTokens = this.normalizePositiveInteger(options.reserveTokens, DEFAULT_RESERVE_TOKENS);
    this.maxToolOutputTokens = this.normalizePositiveInteger(
      options.maxToolOutputTokens,
      DEFAULT_MAX_TOOL_OUTPUT_TOKENS,
    );
    this.keepRecentMessages = this.normalizePositiveInteger(
      options.keepRecentMessages,
      DEFAULT_KEEP_RECENT_MESSAGES,
    );
    this.eventBus = options.eventBus;
  }

  public checkBudget(messages: AgentMessage[]): BudgetCheckResult {
    const estimatedTokens = this.estimateMessagesTokens(messages);
    const budgetTokens = this.getUsableBudgetTokens();

    return {
      fits: estimatedTokens <= budgetTokens,
      estimatedTokens,
      budgetTokens,
    };
  }

  public async compact(messages: AgentMessage[]): Promise<CompactionAction & { messages: AgentMessage[] }> {
    const beforeTokens = this.estimateMessagesTokens(messages);
    const budgetTokens = this.getUsableBudgetTokens();
    if (beforeTokens <= budgetTokens) {
      return {
        type: "none",
        removedMessages: 0,
        prunedToolOutputs: 0,
        beforeTokens,
        afterTokens: beforeTokens,
        messages: messages.map((message) => this.cloneMessage(message)),
      };
    }

    const pruned = this.pruneOlderToolOutputs(messages);
    const afterPruneTokens = this.estimateMessagesTokens(pruned.messages);
    if (afterPruneTokens <= budgetTokens) {
      const actionType = pruned.prunedToolOutputs > 0 ? "prune_tool_outputs" : "none";
      const summary =
        actionType === "none"
          ? undefined
          : `Compacted context by pruning ${pruned.prunedToolOutputs} tool output(s).`;

      if (actionType !== "none") {
        await this.emitCompaction(summary ?? "Compaction completed.", beforeTokens, afterPruneTokens);
      }

      return {
        type: actionType,
        removedMessages: 0,
        prunedToolOutputs: pruned.prunedToolOutputs,
        summary,
        beforeTokens,
        afterTokens: afterPruneTokens,
        messages: pruned.messages,
      };
    }

    const summarized = this.summarizeOlderHistory(pruned.messages);
    const afterTokens = this.estimateMessagesTokens(summarized.messages);
    const actionType = this.resolveActionType(pruned.prunedToolOutputs, summarized.removedMessages);
    const summary =
      summarized.summary ??
      (actionType !== "none"
        ? `Compacted context by pruning ${pruned.prunedToolOutputs} tool output(s).`
        : undefined);

    if (actionType !== "none") {
      await this.emitCompaction(summary ?? "Compaction completed.", beforeTokens, afterTokens);
    }

    return {
      type: actionType,
      removedMessages: summarized.removedMessages,
      prunedToolOutputs: pruned.prunedToolOutputs,
      summary,
      beforeTokens,
      afterTokens,
      messages: summarized.messages,
    };
  }

  private pruneOlderToolOutputs(messages: AgentMessage[]): PruneResult {
    const cloned = messages.map((message) => this.cloneMessage(message));
    const latestToolIndex = this.findLatestToolOutputIndex(cloned);
    if (latestToolIndex <= 0) {
      return { messages: cloned, prunedToolOutputs: 0 };
    }

    let prunedToolOutputs = 0;

    for (let index = 0; index < latestToolIndex; index += 1) {
      const message = cloned[index];
      if (!message || !this.isToolOutputMessage(message)) {
        continue;
      }

      const contentTruncated = this.truncateTextByTokenLimit(message.content, this.maxToolOutputTokens);
      if (contentTruncated.truncated) {
        message.content = contentTruncated.value;
        prunedToolOutputs += 1;
      }

      if (!message.toolResults || message.toolResults.length === 0) {
        continue;
      }

      message.toolResults = message.toolResults.map((result) => {
        const normalizedOutput = this.stringifyOutput(result.output);
        const outputTruncated = this.truncateTextByTokenLimit(normalizedOutput, this.maxToolOutputTokens);
        if (!outputTruncated.truncated) {
          return result;
        }

        prunedToolOutputs += 1;
        return {
          ...result,
          status: "truncated",
          output: outputTruncated.value,
          metadata: {
            ...result.metadata,
            truncated: true,
            originalLength:
              result.metadata.originalLength ??
              (typeof normalizedOutput === "string" ? normalizedOutput.length : undefined),
          },
        };
      });
    }

    return { messages: cloned, prunedToolOutputs };
  }

  private summarizeOlderHistory(messages: AgentMessage[]): SummaryResult {
    const leadingSystemCount = this.countLeadingSystemMessages(messages);
    const recentStart = Math.max(leadingSystemCount, messages.length - this.keepRecentMessages);
    if (recentStart <= leadingSystemCount) {
      return {
        messages,
        removedMessages: 0,
      };
    }

    const historySlice = messages.slice(leadingSystemCount, recentStart);
    const summary = this.buildSummary(historySlice);
    const summaryMessage: AgentMessage = {
      role: "system",
      content: summary,
    };

    const nextMessages: AgentMessage[] = [
      ...messages.slice(0, leadingSystemCount),
      summaryMessage,
      ...messages.slice(recentStart),
    ];

    return {
      messages: nextMessages,
      removedMessages: Math.max(0, historySlice.length - 1),
      summary,
    };
  }

  private buildSummary(messages: AgentMessage[]): string {
    const topics = this.extractTopics(messages);
    const topicSummary = topics.length > 0 ? topics.join(", ") : "general context";
    return `[Compacted: ${messages.length} messages summarized. Key topics: ${topicSummary}]`;
  }

  private extractTopics(messages: AgentMessage[]): string[] {
    const counts = new Map<string, number>();

    for (const message of messages) {
      const words = message.content.toLowerCase().match(/[a-z0-9]{4,}/g) ?? [];
      for (const word of words) {
        if (STOP_WORDS.has(word)) {
          continue;
        }

        counts.set(word, (counts.get(word) ?? 0) + 1);
      }
    }

    return Array.from(counts.entries())
      .sort((left, right) => {
        if (right[1] !== left[1]) {
          return right[1] - left[1];
        }

        return left[0].localeCompare(right[0]);
      })
      .slice(0, 3)
      .map(([word]) => word);
  }

  private resolveActionType(
    prunedToolOutputs: number,
    removedMessages: number,
  ): "none" | "prune_tool_outputs" | "summarize_history" | "both" {
    if (prunedToolOutputs > 0 && removedMessages > 0) {
      return "both";
    }

    if (prunedToolOutputs > 0) {
      return "prune_tool_outputs";
    }

    if (removedMessages > 0) {
      return "summarize_history";
    }

    return "none";
  }

  private async emitCompaction(summary: string, beforeTokenEstimate: number, afterTokenEstimate: number): Promise<void> {
    if (!this.eventBus) {
      return;
    }

    await this.eventBus.emit("compaction", {
      summary,
      beforeTokenEstimate,
      afterTokenEstimate,
    });
  }

  private getUsableBudgetTokens(): number {
    return Math.max(1, this.contextWindowTokens - this.reserveTokens);
  }

  private estimateMessagesTokens(messages: AgentMessage[]): number {
    let total = 3;

    for (const message of messages) {
      total += MESSAGE_TOKEN_OVERHEAD;
      total += estimateTokens(message.role);
      total += estimateTokens(message.content);

      if (message.toolCalls && message.toolCalls.length > 0) {
        total += estimateTokens(JSON.stringify(message.toolCalls));
      }

      if (message.toolResults && message.toolResults.length > 0) {
        total += estimateTokens(JSON.stringify(message.toolResults));
      }
    }

    return total;
  }

  private findLatestToolOutputIndex(messages: AgentMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message && this.isToolOutputMessage(message)) {
        return index;
      }
    }

    return -1;
  }

  private countLeadingSystemMessages(messages: AgentMessage[]): number {
    let count = 0;
    for (const message of messages) {
      if (message.role !== "system") {
        break;
      }

      count += 1;
    }

    return count;
  }

  private isToolOutputMessage(message: AgentMessage): boolean {
    return message.role === "tool" || Boolean(message.toolResults && message.toolResults.length > 0);
  }

  private truncateTextByTokenLimit(
    value: string,
    maxTokens: number,
  ): { value: string; truncated: boolean } {
    if (estimateTokens(value) <= maxTokens) {
      return { value, truncated: false };
    }

    const suffix = OUTPUT_TRUNCATION_SUFFIX;
    const maxChars = Math.max(0, maxTokens * 4 - suffix.length);
    const nextValue = `${value.slice(0, maxChars)}${suffix}`;

    return {
      value: nextValue,
      truncated: true,
    };
  }

  private stringifyOutput(output: unknown): string {
    if (typeof output === "string") {
      return output;
    }

    try {
      const serialized = JSON.stringify(output);
      if (typeof serialized === "string") {
        return serialized;
      }
    } catch {
      return String(output);
    }

    return String(output);
  }

  private cloneMessage(message: AgentMessage): AgentMessage {
    return {
      ...message,
      toolCalls: message.toolCalls ? structuredClone(message.toolCalls) : undefined,
      toolResults: message.toolResults ? structuredClone(message.toolResults) : undefined,
    };
  }

  private normalizePositiveInteger(value: number | undefined, fallback: number): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return fallback;
    }

    return Math.max(1, Math.floor(value));
  }
}
