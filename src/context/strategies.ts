import type { Model, Message, Provider } from "../types";
import { createLogger } from "../logger";
import {
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
} from "./tokenizer";

const log = createLogger("context");

export interface TruncationOptions {
  maxTokens: number;
  reservedTokens: number;
  model?: Model;
  keepRecentMessages?: number;
}

export interface TruncationStrategy {
  truncate(messages: Message[], options: TruncationOptions): Message[];
}

export interface AsyncTruncationStrategy {
  truncate(messages: Message[], options: TruncationOptions): Promise<Message[]>;
}

export interface SummarisationStrategyOptions {
  provider: Provider;
  model: string;
  summaryMaxTokens?: number;
  summaryPrompt?: string;
}

const DEFAULT_SUMMARY_MAX_TOKENS = 500;
const DEFAULT_KEEP_RECENT_MESSAGES = 20;
const DEFAULT_SUMMARY_PROMPT =
  "You are summarising a conversation to reduce context. Create a concise summary of the following messages that preserves all important information, decisions, and context needed to continue the conversation naturally. Be thorough but concise.";

const CONVERSATION_OVERHEAD = 3;
const MESSAGE_BASE_OVERHEAD = 5;

function toEffectiveLimit(options: TruncationOptions): number {
  const rawLimit = options.model?.contextWindow ?? options.maxTokens;
  return Math.max(1, rawLimit - options.reservedTokens);
}

function truncateTextToBudget(text: string, tokenBudget: number): string {
  if (tokenBudget <= 1) {
    return "";
  }

  let candidate = text.slice(0, tokenBudget * 4);
  while (candidate.length > 0 && estimateTokens(candidate) > tokenBudget) {
    candidate = candidate.slice(0, -1);
  }

  return candidate;
}

function truncateMessageContent(message: Message, maxMessageTokens: number): Message {
  if (estimateMessageTokens(message) <= maxMessageTokens) {
    return message;
  }

  const toolCallTokens =
    message.toolCalls && message.toolCalls.length > 0
      ? estimateTokens(JSON.stringify(message.toolCalls))
      : 0;
  const toolResultTokens = message.toolResultId ? estimateTokens(message.toolResultId) : 0;

  const contentBudget = Math.max(
    1,
    maxMessageTokens - MESSAGE_BASE_OVERHEAD - toolCallTokens - toolResultTokens,
  );

  // Tool block messages are not truncated — they must be preserved intact
  if (typeof message.content !== "string") {
    return message;
  }

  return {
    ...message,
    content: truncateTextToBudget(message.content, contentBudget),
  };
}

function preserveMessageOrder(source: Message[], keep: Set<string>): Message[] {
  return source.filter((message) => keep.has(message.id));
}

function toSummaryText(message: Message): string {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .map((block) => {
            if (block.type === "text") {
              return block.text;
            }

            if (block.type === "tool_use") {
              return `[tool_use:${block.name}] ${JSON.stringify(block.input)}`;
            }

            if (block.type === "image") {
              return `[image:${block.mimeType ?? "unknown"}] ${block.url}`;
            }

            return `[tool_result:${block.tool_use_id}] ${block.content}`;
          })
          .join("\n");

  return `${message.role.toUpperCase()}: ${content}`;
}

export class SummarisationStrategy implements AsyncTruncationStrategy {
  private readonly fallbackStrategy = new DropOldestStrategy();

  constructor(private readonly options: SummarisationStrategyOptions) {}

  async truncate(messages: Message[], options: TruncationOptions): Promise<Message[]> {
    const systemMessages = messages.filter(
      (message) => message.role === "system" && message.isSummary !== true,
    );
    const existingSummaryMessages = messages.filter((message) => message.isSummary === true);
    const regularMessages = messages.filter(
      (message) => message.role !== "system" && message.isSummary !== true,
    );
    const keepRecent = Math.max(
      0,
      options.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
    );

    if (messages.length <= keepRecent + systemMessages.length) {
      return [...messages];
    }

    if (regularMessages.length <= keepRecent) {
      return [...messages];
    }

    const splitIndex = Math.max(0, regularMessages.length - keepRecent);
    const oldestMessages = regularMessages.slice(0, splitIndex);
    const recentMessages = regularMessages.slice(splitIndex);

    if (oldestMessages.length === 0) {
      return [...messages];
    }

    try {
      const summaryResponse = await this.options.provider.chat({
        model: this.options.model,
        systemPrompt: this.options.summaryPrompt ?? DEFAULT_SUMMARY_PROMPT,
        messages: [
          {
            id: "summarisation-request",
            role: "user",
            content: oldestMessages.map(toSummaryText).join("\n\n"),
            createdAt: new Date(),
          },
        ],
        maxTokens: this.options.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
      });

      const summaryTokenBudget = this.options.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS;
      const summaryContent = truncateTextToBudget(summaryResponse.content, summaryTokenBudget);

      const syntheticSummary: Message = {
        id: `summary-${Date.now()}`,
        role: "system",
        content: summaryContent,
        isSummary: true,
        createdAt: new Date(),
      };

      return [
        ...systemMessages,
        ...existingSummaryMessages,
        syntheticSummary,
        ...recentMessages,
      ];
    } catch (error) {
      log.warn("SummarisationStrategy failed; using DropOldestStrategy fallback", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.fallbackStrategy.truncate(messages, options);
    }
  }
}

export class DropOldestStrategy implements TruncationStrategy {
  truncate(messages: Message[], options: TruncationOptions): Message[] {
    const effectiveLimit = toEffectiveLimit(options);
    const next = [...messages];

    while (estimateConversationTokens(next) > effectiveLimit) {
      const dropIndex = next.findIndex(
        (message) => message.role !== "system" && message.isSummary !== true,
      );
      if (dropIndex === -1) {
        break;
      }

      next.splice(dropIndex, 1);
    }

    if (estimateConversationTokens(next) <= effectiveLimit) {
      return next;
    }

    return next.map((message) =>
      truncateMessageContent(message, Math.max(1, effectiveLimit - CONVERSATION_OVERHEAD)),
    );
  }
}

export class SlidingWindowStrategy implements TruncationStrategy {
  truncate(messages: Message[], options: TruncationOptions): Message[] {
    const effectiveLimit = toEffectiveLimit(options);
    if (estimateConversationTokens(messages) <= effectiveLimit) {
      return messages;
    }

    const alwaysKeepMessages = messages.filter(
      (message) => message.role === "system" || message.isSummary === true,
    );
    const nonSystemMessages = messages.filter(
      (message) => message.role !== "system" && message.isSummary !== true,
    );
    const selectedIds = new Set(alwaysKeepMessages.map((message) => message.id));

    for (let index = nonSystemMessages.length - 1; index >= 0; index -= 1) {
      const candidate = nonSystemMessages[index];
      if (!candidate) {
        continue;
      }

      selectedIds.add(candidate.id);
      const next = preserveMessageOrder(messages, selectedIds);
      if (estimateConversationTokens(next) > effectiveLimit) {
        selectedIds.delete(candidate.id);
      }
    }

    let truncated = preserveMessageOrder(messages, selectedIds);
    if (truncated.length > 0 && estimateConversationTokens(truncated) <= effectiveLimit) {
      return truncated;
    }

    const latest = nonSystemMessages[nonSystemMessages.length - 1];
    if (!latest) {
      return alwaysKeepMessages.map((message) =>
        truncateMessageContent(message, Math.max(1, effectiveLimit - CONVERSATION_OVERHEAD)),
      );
    }

    const trimmedLatest = truncateMessageContent(
      latest,
      Math.max(1, effectiveLimit - estimateConversationTokens(alwaysKeepMessages)),
    );
    truncated = [...alwaysKeepMessages, trimmedLatest];

    return truncated;
  }
}

export class KeepSystemAndRecentStrategy implements TruncationStrategy {
  truncate(messages: Message[], options: TruncationOptions): Message[] {
    const effectiveLimit = toEffectiveLimit(options);
    if (estimateConversationTokens(messages) <= effectiveLimit) {
      return messages;
    }

    const alwaysKeepMessages = messages.filter(
      (message) => message.role === "system" || message.isSummary === true,
    );
    const nonSystemMessages = messages.filter(
      (message) => message.role !== "system" && message.isSummary !== true,
    );
    const chunks: Message[][] = [];

    for (let index = 0; index < nonSystemMessages.length; index += 1) {
      const current = nonSystemMessages[index];
      const next = nonSystemMessages[index + 1];

      if (current?.role === "user" && next?.role === "assistant") {
        chunks.push([current, next]);
        index += 1;
        continue;
      }

      if (current) {
        chunks.push([current]);
      }
    }

    const selectedIds = new Set(alwaysKeepMessages.map((message) => message.id));

    for (let chunkIndex = chunks.length - 1; chunkIndex >= 0; chunkIndex -= 1) {
      const chunk = chunks[chunkIndex];
      if (!chunk) {
        continue;
      }

      for (const message of chunk) {
        selectedIds.add(message.id);
      }

      const next = preserveMessageOrder(messages, selectedIds);
      if (estimateConversationTokens(next) > effectiveLimit) {
        for (const message of chunk) {
          selectedIds.delete(message.id);
        }
      }
    }

    const selected = preserveMessageOrder(messages, selectedIds);
    if (selected.length > 0 && estimateConversationTokens(selected) <= effectiveLimit) {
      return selected;
    }

    const latest = nonSystemMessages[nonSystemMessages.length - 1];
    if (!latest) {
      return alwaysKeepMessages.map((message) =>
        truncateMessageContent(message, Math.max(1, effectiveLimit - CONVERSATION_OVERHEAD)),
      );
    }

    const trimmedLatest = truncateMessageContent(
      latest,
      Math.max(1, effectiveLimit - estimateConversationTokens(alwaysKeepMessages)),
    );
    return [...alwaysKeepMessages, trimmedLatest];
  }
}
