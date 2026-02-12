import type { TokenUsage } from "./provider";
import type { ToolCall, ToolResult } from "./tool";

export type StreamEvent =
  | { type: "message_start"; messageId: string; conversationId?: string; model?: string }
  | { type: "token"; content: string }
  | { type: "tool_call_start"; toolCall: ToolCall }
  | { type: "tool_call_end"; result: ToolResult }
  | { type: "compaction"; summary: string; beforeTokenEstimate: number; afterTokenEstimate: number }
  | { type: "error"; error: Error }
  | { type: "done"; usage: TokenUsage; finishReason: string };
