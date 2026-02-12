import type { ToolCall } from "./tool";
import type { Result } from "../result";

export type MessageRole = "user" | "assistant" | "system" | "tool";

export interface Message {
  id: string;
  role: MessageRole;
  content: string;
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
