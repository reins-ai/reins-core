import type { TokenUsage, ToolCall, ToolResult } from "../types";

export const HARNESS_EVENT_VERSION = 1;

export const harnessEventTypes = [
  "message_start",
  "token",
  "tool_call_start",
  "tool_call_end",
  "compaction",
  "error",
  "done",
  "permission_request",
  "aborted",
  "child_agent_event",
] as const;

export type HarnessEventType = (typeof harnessEventTypes)[number];

export interface MessageStartEventPayload {
  messageId: string;
  conversationId: string;
  model: string;
}

export interface TokenEventPayload {
  content: string;
}

export interface ToolCallStartEventPayload {
  toolCall: ToolCall;
}

export interface ToolCallEndEventPayload {
  result: ToolResult;
}

export interface CompactionEventPayload {
  summary: string;
  beforeTokenEstimate: number;
  afterTokenEstimate: number;
}

export interface ErrorEventPayload {
  error: Error;
  code?: string;
  retryable?: boolean;
}

export interface DoneEventPayload {
  usage: TokenUsage;
  finishReason: string;
}

export interface PermissionRequestEventPayload {
  requestId: string;
  toolCall: ToolCall;
  profile: "minimal" | "standard" | "full";
  reason?: string;
}

export interface AbortedEventPayload {
  reason?: string;
  initiatedBy: "user" | "system";
}

export interface ChildAgentEventPayload {
  childId: string;
  eventType: HarnessEventType;
  payload: unknown;
}

export interface HarnessEventMap {
  message_start: MessageStartEventPayload;
  token: TokenEventPayload;
  tool_call_start: ToolCallStartEventPayload;
  tool_call_end: ToolCallEndEventPayload;
  compaction: CompactionEventPayload;
  error: ErrorEventPayload;
  done: DoneEventPayload;
  permission_request: PermissionRequestEventPayload;
  aborted: AbortedEventPayload;
  child_agent_event: ChildAgentEventPayload;
}

export interface EventEnvelope<TType extends string, TPayload> {
  type: TType;
  payload: TPayload;
  version: number;
  timestamp: number;
  eventId: string;
}

export type HarnessEvent<TKey extends HarnessEventType = HarnessEventType> =
  EventEnvelope<TKey, HarnessEventMap[TKey]>;

let eventCounter = 0;

export function createEventId(prefix = "evt"): string {
  eventCounter += 1;
  return `${prefix}_${Date.now()}_${eventCounter}`;
}

export function createHarnessEvent<TKey extends HarnessEventType>(params: {
  type: TKey;
  payload: HarnessEventMap[TKey];
  version?: number;
  timestamp?: number;
  eventId?: string;
}): HarnessEvent<TKey> {
  return {
    type: params.type,
    payload: params.payload,
    version: params.version ?? HARNESS_EVENT_VERSION,
    timestamp: params.timestamp ?? Date.now(),
    eventId: params.eventId ?? createEventId(),
  };
}
