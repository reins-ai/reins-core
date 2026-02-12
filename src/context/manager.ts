import { ConversationError } from "../errors";
import type { Model, Message } from "../types";
import { estimateConversationTokens } from "./tokenizer";
import type { TruncationStrategy } from "./strategies";

export interface ContextManagerConfig {
  strategy: TruncationStrategy;
  defaultMaxTokens?: number;
  modelTokenLimits?: Record<string, number>;
}

export interface PrepareOptions {
  maxTokens?: number;
  reservedForOutput?: number;
  systemPrompt?: string;
  model?: Model;
  modelId?: string;
}

export interface UsageReport {
  totalTokens: number;
  maxTokens: number;
  utilization: number;
  needsTruncation: boolean;
}

export class ContextManager {
  constructor(private readonly config: ContextManagerConfig) {}

  prepare(messages: Message[], options: PrepareOptions): Message[] {
    const prepared = this.ensureSystemPrompt(messages, options.systemPrompt);
    const maxTokens = this.resolveMaxTokens(options);
    const reservedForOutput = Math.max(0, options.reservedForOutput ?? 0);
    const effectiveLimit = maxTokens - reservedForOutput;

    if (effectiveLimit < 1) {
      throw new ConversationError("Effective token limit must be greater than zero");
    }

    if (this.estimateTokens(prepared) <= effectiveLimit) {
      return prepared;
    }

    return this.config.strategy.truncate(prepared, {
      maxTokens,
      reservedTokens: reservedForOutput,
      model: options.model,
    });
  }

  estimateTokens(messages: Message[]): number {
    return estimateConversationTokens(messages);
  }

  willExceedLimit(messages: Message[], maxTokens: number): boolean {
    return this.estimateTokens(messages) > maxTokens;
  }

  getUsageReport(messages: Message[], maxTokens: number): UsageReport {
    const totalTokens = this.estimateTokens(messages);
    return {
      totalTokens,
      maxTokens,
      utilization: maxTokens === 0 ? 0 : totalTokens / maxTokens,
      needsTruncation: totalTokens > maxTokens,
    };
  }

  private ensureSystemPrompt(messages: Message[], systemPrompt?: string): Message[] {
    const normalizedPrompt = systemPrompt?.trim();
    if (!normalizedPrompt) {
      return messages;
    }

    const hasSystemMessage = messages.some((message) => message.role === "system");
    if (hasSystemMessage) {
      return messages;
    }

    return [
      {
        id: "system_prompt",
        role: "system",
        content: normalizedPrompt,
        createdAt: new Date(0),
      },
      ...messages,
    ];
  }

  private resolveMaxTokens(options: PrepareOptions): number {
    if (typeof options.maxTokens === "number") {
      return options.maxTokens;
    }

    if (options.model?.contextWindow) {
      return options.model.contextWindow;
    }

    if (options.modelId && this.config.modelTokenLimits?.[options.modelId]) {
      return this.config.modelTokenLimits[options.modelId];
    }

    if (typeof this.config.defaultMaxTokens === "number") {
      return this.config.defaultMaxTokens;
    }

    throw new ConversationError("No token limit available. Set maxTokens, model, or defaultMaxTokens");
  }
}
