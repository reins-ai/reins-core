import type { Message } from "../types";

const CHARS_PER_TOKEN = 4;
const MIN_TOKEN_COUNT = 1;
const MESSAGE_FRAMING_OVERHEAD = 4;
const CONVERSATION_FRAMING_OVERHEAD = 3;
const ROLE_TOKEN_COST = 1;

const SEGMENT_SPLIT_REGEX = /[\s.,!?;:()\[\]{}"'`~@#$%^&*+=<>\\/|_-]+/u;

export function estimateTokens(text: string): number {
  const normalized = text.trim();
  if (!normalized) {
    return MIN_TOKEN_COUNT;
  }

  const segments = normalized.split(SEGMENT_SPLIT_REGEX).filter(Boolean);
  const segmentEstimate = segments.length;
  const lengthEstimate = Math.ceil(normalized.length / CHARS_PER_TOKEN);

  return Math.max(MIN_TOKEN_COUNT, segmentEstimate, lengthEstimate);
}

export function estimateMessageTokens(message: Message): number {
  let total = MESSAGE_FRAMING_OVERHEAD + ROLE_TOKEN_COST;

  total += estimateTokens(message.content);

  if (message.toolCalls && message.toolCalls.length > 0) {
    total += estimateTokens(JSON.stringify(message.toolCalls));
  }

  if (message.toolResultId) {
    total += estimateTokens(message.toolResultId);
  }

  return total;
}

export function estimateConversationTokens(messages: Message[]): number {
  const messageTokens = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  return CONVERSATION_FRAMING_OVERHEAD + messageTokens;
}
