import type { ToolCall } from "./tool";
import type { Result } from "../result";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

/**
 * Extract plain text from message content.
 * Returns the string directly for string content, or concatenates
 * all text blocks for ContentBlock[] content.
 */
export function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }

  return content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * Serialize message content for storage or transport.
 * Returns the string directly for string content, or JSON-stringifies
 * ContentBlock[] content.
 */
export function serializeContent(content: string | ContentBlock[]): string {
  if (typeof content === "string") {
    return content;
  }

  return JSON.stringify(content);
}

/**
 * Deserialize stored content back to its runtime representation.
 * If the value is a JSON array of ContentBlock objects, returns ContentBlock[].
 * Otherwise returns the plain string.
 */
export function deserializeContent(value: string): string | ContentBlock[] {
  if (!value.startsWith("[")) {
    return value;
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return value;
    }

    const first = parsed[0] as Record<string, unknown>;
    if (typeof first.type !== "string") {
      return value;
    }

    const validTypes = new Set(["text", "tool_use", "tool_result"]);
    if (!validTypes.has(first.type)) {
      return value;
    }

    return parsed as ContentBlock[];
  } catch {
    return value;
  }
}

/**
 * Check if message content contains tool blocks.
 */
export function hasToolBlocks(content: string | ContentBlock[]): boolean {
  if (typeof content === "string") {
    return false;
  }

  return content.some((block) => block.type === "tool_use" || block.type === "tool_result");
}

export interface Message {
  id: string;
  role: MessageRole;
  content: string | ContentBlock[];
  toolCalls?: ToolCall[];
  toolResultId?: string;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  model: string;
  provider: string;
  personaId?: string;
  workspaceId?: string;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface ConversationSummary {
  id: string;
  title: string;
  model: string;
  provider?: string;
  messageCount: number;
  lastMessageAt: Date;
  createdAt: Date;
  updatedAt?: Date;
}

export type DaemonMessageRole = Extract<MessageRole, "system" | "user" | "assistant">;

export interface DaemonMessageRecordDto {
  id: string;
  role: DaemonMessageRole;
  content: string;
  createdAt: string;
  provider?: string;
  model?: string;
}

export interface DaemonConversationSummaryDto {
  id: string;
  title: string;
  model: string;
  provider?: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DaemonConversationRecordDto extends DaemonConversationSummaryDto {
  messages: DaemonMessageRecordDto[];
}

export interface DaemonCreateConversationRequestDto {
  title?: string;
  model?: string;
  provider?: string;
}

export interface DaemonUpdateConversationRequestDto {
  title?: string;
  model?: string;
}

export interface DaemonPostMessageRequestDto {
  conversationId?: string;
  content: string;
  role?: DaemonMessageRole;
  model?: string;
  provider?: string;
}

export interface DaemonPostMessageResponseDto {
  conversationId: string;
  messageId: string;
  assistantMessageId: string;
  timestamp: string;
  userMessageId?: string;
}

export interface DaemonStreamSubscribeRequestDto {
  type: "stream.subscribe";
  conversationId: string;
  assistantMessageId: string;
}

export type DaemonStreamLifecycleEventType = "message_start" | "content_chunk" | "message_complete" | "error";
export type DaemonStreamLegacyEventType = "start" | "delta" | "complete" | "error";

export type DaemonStreamEventType = DaemonStreamLifecycleEventType | DaemonStreamLegacyEventType;

export interface DaemonConversationServiceError {
  code:
    | "INVALID_REQUEST"
    | "NOT_FOUND"
    | "CONFLICT"
    | "UNAUTHORIZED"
    | "PROVIDER_UNAVAILABLE"
    | "INTERNAL_ERROR";
  message: string;
  retryable: boolean;
}

export interface DaemonConversationService {
  createConversation(
    request: DaemonCreateConversationRequestDto,
  ): Promise<Result<DaemonConversationRecordDto, DaemonConversationServiceError>>;
  listConversations(): Promise<Result<DaemonConversationSummaryDto[], DaemonConversationServiceError>>;
  getConversation(conversationId: string): Promise<Result<DaemonConversationRecordDto, DaemonConversationServiceError>>;
  deleteConversation(conversationId: string): Promise<Result<void, DaemonConversationServiceError>>;
}

export interface DaemonMessageService {
  postMessage(request: DaemonPostMessageRequestDto): Promise<Result<DaemonPostMessageResponseDto, DaemonConversationServiceError>>;
}
