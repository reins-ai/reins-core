import type { TranscriptEntry } from "../conversation/transcript-types";
import type { TokenUsage } from "../types/provider";
import type { StreamEvent } from "../types/streaming";
import type { ToolCall } from "../types/tool";

export interface CollectedResponse {
  content: string;
  toolCalls: ToolCall[];
  usage: TokenUsage;
  finishReason: string;
}

type TokenCallback = (token: string) => void;
type ToolCallCallback = (toolCall: ToolCall) => void;
type ErrorCallback = (error: Error) => void;
type DoneCallback = (usage: TokenUsage, finishReason: string) => void;
type TranscriptCallback = (entry: TranscriptEntry) => void | Promise<void>;

interface TranscriptTurnContext {
  turnId: string;
  model: string;
  provider: string;
}

export interface StreamingResponseOptions {
  signal?: AbortSignal;
  onTranscript?: TranscriptCallback;
  turn?: TranscriptTurnContext;
  includeTokenEvents?: boolean;
  assistantMessageIdFactory?: () => string;
}

function createDefaultUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value;
  }

  return new Error(String(value));
}

export class StreamingResponse implements AsyncIterable<StreamEvent> {
  private readonly source: AsyncIterable<StreamEvent>;
  private readonly controller = new AbortController();
  private readonly tokenCallbacks: TokenCallback[] = [];
  private readonly toolCallCallbacks: ToolCallCallback[] = [];
  private readonly errorCallbacks: ErrorCallback[] = [];
  private readonly doneCallbacks: DoneCallback[] = [];
  private readonly transcriptCallbacks: TranscriptCallback[] = [];
  private readonly externalSignal?: AbortSignal;
  private readonly transcriptTurn?: TranscriptTurnContext;
  private readonly includeTokenEvents: boolean;
  private readonly assistantMessageIdFactory: () => string;
  private readonly turnStartTimestamp = Date.now();
  private turnStartEmitted = false;
  private assistantMessageContent = "";

  constructor(source: AsyncIterable<StreamEvent>, signalOrOptions?: AbortSignal | StreamingResponseOptions) {
    const options = normalizeOptions(signalOrOptions);

    this.source = source;
    this.externalSignal = options.signal;
    this.transcriptTurn = options.turn;
    this.includeTokenEvents = options.includeTokenEvents ?? false;
    this.assistantMessageIdFactory = options.assistantMessageIdFactory ?? defaultAssistantMessageId;

    if (options.onTranscript) {
      this.transcriptCallbacks.push(options.onTranscript);
    }

    if (this.externalSignal?.aborted) {
      this.controller.abort();
      return;
    }

    this.externalSignal?.addEventListener("abort", this.handleExternalAbort);
  }

  public [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    return this.iterate();
  }

  public onToken(callback: TokenCallback): StreamingResponse {
    this.tokenCallbacks.push(callback);
    return this;
  }

  public onToolCall(callback: ToolCallCallback): StreamingResponse {
    this.toolCallCallbacks.push(callback);
    return this;
  }

  public onError(callback: ErrorCallback): StreamingResponse {
    this.errorCallbacks.push(callback);
    return this;
  }

  public onDone(callback: DoneCallback): StreamingResponse {
    this.doneCallbacks.push(callback);
    return this;
  }

  public onTranscript(callback: TranscriptCallback): StreamingResponse {
    this.transcriptCallbacks.push(callback);
    return this;
  }

  public cancel(): void {
    this.controller.abort();
  }

  public get aborted(): boolean {
    return this.controller.signal.aborted;
  }

  public async collect(): Promise<CollectedResponse> {
    let content = "";
    const toolCalls: ToolCall[] = [];
    let usage = createDefaultUsage();
    let finishReason = this.aborted ? "cancelled" : "unknown";

    for await (const event of this) {
      if (event.type === "token") {
        content += event.content;
      }

      if (event.type === "tool_call_start") {
        toolCalls.push(event.toolCall);
      }

      if (event.type === "done") {
        usage = event.usage;
        finishReason = event.finishReason;
      }
    }

    if (this.aborted && finishReason === "unknown") {
      finishReason = "cancelled";
    }

    return {
      content,
      toolCalls,
      usage,
      finishReason,
    };
  }

  private readonly handleExternalAbort = (): void => {
    this.controller.abort();
  };

  private async *iterate(): AsyncGenerator<StreamEvent> {
    try {
      for await (const event of this.source) {
        if (this.aborted) {
          break;
        }

        await this.dispatch(event);
        yield event;

        if (event.type === "done") {
          break;
        }
      }
    } catch (error) {
      if (this.aborted) {
        return;
      }

      const normalizedError = toError(error);
      const errorEvent: StreamEvent = { type: "error", error: normalizedError };
      await this.dispatch(errorEvent);
      yield errorEvent;
    } finally {
      this.externalSignal?.removeEventListener("abort", this.handleExternalAbort);
    }
  }

  private async dispatch(event: StreamEvent): Promise<void> {
    if (event.type === "token") {
      this.assistantMessageContent += event.content;

      for (const callback of this.tokenCallbacks) {
        callback(event.content);
      }

      if (this.includeTokenEvents) {
        await this.emitTranscript({
          type: "token",
          timestamp: new Date().toISOString(),
          content: event.content,
        });
      }
      return;
    }

    if (event.type === "tool_call_start") {
      await this.ensureTurnStart();

      for (const callback of this.toolCallCallbacks) {
        callback(event.toolCall);
      }

      await this.emitTranscript({
        type: "tool_call",
        timestamp: new Date().toISOString(),
        toolName: event.toolCall.name,
        toolCallId: event.toolCall.id,
        input: event.toolCall.arguments,
      });

      return;
    }

    if (event.type === "tool_call_end") {
      await this.ensureTurnStart();

      await this.emitTranscript({
        type: "tool_result",
        timestamp: new Date().toISOString(),
        toolCallId: event.result.callId,
        output: event.result.result,
        isError: event.result.error !== undefined,
      });
      return;
    }

    if (event.type === "error") {
      await this.ensureTurnStart();

      for (const callback of this.errorCallbacks) {
        callback(event.error);
      }

      await this.emitTranscript({
        type: "error",
        timestamp: new Date().toISOString(),
        code: "STREAM_ERROR",
        message: event.error.message,
      });

      return;
    }

    if (event.type === "done") {
      await this.ensureTurnStart();

      for (const callback of this.doneCallbacks) {
        callback(event.usage, event.finishReason);
      }

      if (this.assistantMessageContent.length > 0) {
        await this.emitTranscript({
          type: "message",
          timestamp: new Date().toISOString(),
          role: "assistant",
          content: this.assistantMessageContent,
          messageId: this.assistantMessageIdFactory(),
        });

        this.assistantMessageContent = "";
      }

      if (this.transcriptTurn) {
        await this.emitTranscript({
          type: "turn_end",
          timestamp: new Date().toISOString(),
          turnId: this.transcriptTurn.turnId,
          inputTokens: event.usage.inputTokens,
          outputTokens: event.usage.outputTokens,
          durationMs: Math.max(0, Date.now() - this.turnStartTimestamp),
        });
      }
    }
  }

  private async ensureTurnStart(): Promise<void> {
    if (this.turnStartEmitted || !this.transcriptTurn) {
      return;
    }

    this.turnStartEmitted = true;
    await this.emitTranscript({
      type: "turn_start",
      timestamp: new Date().toISOString(),
      turnId: this.transcriptTurn.turnId,
      model: this.transcriptTurn.model,
      provider: this.transcriptTurn.provider,
    });
  }

  private async emitTranscript(entry: TranscriptEntry): Promise<void> {
    if (this.transcriptCallbacks.length === 0) {
      return;
    }

    for (const callback of this.transcriptCallbacks) {
      try {
        await callback(entry);
      } catch (error) {
        const normalized = toError(error);
        for (const onError of this.errorCallbacks) {
          onError(normalized);
        }
      }
    }
  }
}

function normalizeOptions(
  signalOrOptions?: AbortSignal | StreamingResponseOptions,
): StreamingResponseOptions {
  if (!signalOrOptions) {
    return {};
  }

  if (isAbortSignal(signalOrOptions)) {
    return { signal: signalOrOptions };
  }

  return signalOrOptions;
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    "aborted" in value &&
    "addEventListener" in value &&
    "removeEventListener" in value
  );
}

function defaultAssistantMessageId(): string {
  return `msg_${crypto.randomUUID()}`;
}
