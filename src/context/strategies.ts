import type { Model, Message } from "../types";
import {
  estimateConversationTokens,
  estimateMessageTokens,
  estimateTokens,
} from "./tokenizer";

export interface TruncationOptions {
  maxTokens: number;
  reservedTokens: number;
  model?: Model;
}

export interface TruncationStrategy {
  truncate(messages: Message[], options: TruncationOptions): Message[];
}

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

export class DropOldestStrategy implements TruncationStrategy {
  truncate(messages: Message[], options: TruncationOptions): Message[] {
    const effectiveLimit = toEffectiveLimit(options);
    const next = [...messages];

    while (estimateConversationTokens(next) > effectiveLimit) {
      const dropIndex = next.findIndex((message) => message.role !== "system");
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

    const systemMessages = messages.filter((message) => message.role === "system");
    const nonSystemMessages = messages.filter((message) => message.role !== "system");
    const selectedIds = new Set(systemMessages.map((message) => message.id));

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
      return systemMessages.map((message) =>
        truncateMessageContent(message, Math.max(1, effectiveLimit - CONVERSATION_OVERHEAD)),
      );
    }

    const trimmedLatest = truncateMessageContent(
      latest,
      Math.max(1, effectiveLimit - estimateConversationTokens(systemMessages)),
    );
    truncated = [...systemMessages, trimmedLatest];

    return truncated;
  }
}

export class KeepSystemAndRecentStrategy implements TruncationStrategy {
  truncate(messages: Message[], options: TruncationOptions): Message[] {
    const effectiveLimit = toEffectiveLimit(options);
    if (estimateConversationTokens(messages) <= effectiveLimit) {
      return messages;
    }

    const systemMessages = messages.filter((message) => message.role === "system");
    const nonSystemMessages = messages.filter((message) => message.role !== "system");
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

    const selectedIds = new Set(systemMessages.map((message) => message.id));

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
      return systemMessages.map((message) =>
        truncateMessageContent(message, Math.max(1, effectiveLimit - CONVERSATION_OVERHEAD)),
      );
    }

    const trimmedLatest = truncateMessageContent(
      latest,
      Math.max(1, effectiveLimit - estimateConversationTokens(systemMessages)),
    );
    return [...systemMessages, trimmedLatest];
  }
}
