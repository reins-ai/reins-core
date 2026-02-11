export type TranscriptMessageRole = "user" | "assistant" | "system";

export type TranscriptEntry =
  | {
      type: "message";
      timestamp: string;
      role: TranscriptMessageRole;
      content: string;
      messageId: string;
    }
  | {
      type: "tool_call";
      timestamp: string;
      toolName: string;
      toolCallId: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      timestamp: string;
      toolCallId: string;
      output: unknown;
      isError: boolean;
    }
  | {
      type: "token";
      timestamp: string;
      content: string;
    }
  | {
      type: "turn_start";
      timestamp: string;
      turnId: string;
      model: string;
      provider: string;
    }
  | {
      type: "turn_end";
      timestamp: string;
      turnId: string;
      inputTokens: number;
      outputTokens: number;
      durationMs: number;
    }
  | {
      type: "compaction";
      timestamp: string;
      summary: string;
      messagesCompacted: number;
    }
  | {
      type: "memory_flush";
      timestamp: string;
      memoriesCount: number;
    }
  | {
      type: "session_start";
      timestamp: string;
      sessionId: string;
    }
  | {
      type: "error";
      timestamp: string;
      code: string;
      message: string;
    };
