import type { TokenUsage } from "../types/provider";
import type { StreamEvent } from "../types/streaming";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return value;
}

function asTokenUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = value.inputTokens;
  const outputTokens = value.outputTokens;
  const totalTokens = value.totalTokens;

  if (
    typeof inputTokens === "number" &&
    typeof outputTokens === "number" &&
    typeof totalTokens === "number"
  ) {
    return { inputTokens, outputTokens, totalTokens };
  }

  return undefined;
}

function asAnthropicUsage(value: unknown): TokenUsage | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const inputTokens = typeof value.input_tokens === "number" ? value.input_tokens : 0;
  const outputTokens = typeof value.output_tokens === "number" ? value.output_tokens : 0;
  const totalTokens = inputTokens + outputTokens;

  if (totalTokens === 0 && typeof value.input_tokens !== "number" && typeof value.output_tokens !== "number") {
    return undefined;
  }

  return { inputTokens, outputTokens, totalTokens };
}

function normalizeParsedEvent(payload: unknown): StreamEvent[] {
  if (!isRecord(payload)) {
    return [{ type: "error", error: new Error("Invalid stream payload") }];
  }

  const type = payload.type;

  if (type === "token") {
    const content = asString(payload.content);
    if (content === undefined) {
      return [{ type: "error", error: new Error("Invalid token event payload") }];
    }
    return [{ type: "token", content }];
  }

  if (type === "tool_call_start") {
    const toolCall = payload.toolCall;
    if (!isRecord(toolCall)) {
      return [{ type: "error", error: new Error("Invalid tool_call_start event payload") }];
    }

    const id = asString(toolCall.id);
    const name = asString(toolCall.name);
    const args = toolCall.arguments;

    if (id === undefined || name === undefined || !isRecord(args)) {
      return [{ type: "error", error: new Error("Invalid tool call data") }];
    }

    return [
      {
        type: "tool_call_start",
        toolCall: {
          id,
          name,
          arguments: args,
        },
      },
    ];
  }

  if (type === "tool_call_end") {
    const result = payload.result;
    if (!isRecord(result)) {
      return [{ type: "error", error: new Error("Invalid tool_call_end event payload") }];
    }

    const callId = asString(result.callId);
    const name = asString(result.name);
    const error = result.error;

    if (callId === undefined || name === undefined) {
      return [{ type: "error", error: new Error("Invalid tool result data") }];
    }

    return [
      {
        type: "tool_call_end",
        result: {
          callId,
          name,
          result: result.result,
          error: typeof error === "string" ? error : undefined,
        },
      },
    ];
  }

  if (type === "error") {
    const message = asString(payload.message) ?? asString(payload.error) ?? "Stream error";
    return [{ type: "error", error: new Error(message) }];
  }

  if (type === "done") {
    const usage = asTokenUsage(payload.usage) ?? createDefaultUsage();
    const finishReason = asString(payload.finishReason) ?? "stop";
    return [{ type: "done", usage, finishReason }];
  }

  if (type === "message_start") {
    const messageId = asString(payload.messageId);
    if (messageId === undefined) {
      return [];
    }

    return [
      {
        type: "message_start",
        messageId,
        conversationId: asString(payload.conversationId),
        model: asString(payload.model),
      },
    ];
  }

  if (type === "compaction") {
    const summary = asString(payload.summary);
    const beforeTokenEstimate = payload.beforeTokenEstimate;
    const afterTokenEstimate = payload.afterTokenEstimate;

    if (
      summary === undefined ||
      typeof beforeTokenEstimate !== "number" ||
      typeof afterTokenEstimate !== "number"
    ) {
      return [{ type: "error", error: new Error("Invalid compaction event payload") }];
    }

    return [
      {
        type: "compaction",
        summary,
        beforeTokenEstimate,
        afterTokenEstimate,
      },
    ];
  }

  if (type === "content_block_delta") {
    const delta = payload.delta;
    if (isRecord(delta)) {
      const text = asString(delta.text);
      if (text !== undefined && text.length > 0) {
        return [{ type: "token", content: text }];
      }
    }

    return [];
  }

  if (type === "message_delta") {
    const delta = isRecord(payload.delta) ? payload.delta : undefined;
    const finishReason = asString(delta?.stop_reason) ?? "stop";
    const usage = asAnthropicUsage(payload.usage) ?? createDefaultUsage();
    return [{ type: "done", usage, finishReason }];
  }

  if (type === "message_stop") {
    return [{ type: "done", usage: createDefaultUsage(), finishReason: "stop" }];
  }

  if (type === "message_start" || type === "content_block_start" || type === "content_block_stop" || type === "ping") {
    return [];
  }

  const choices = payload.choices;
  if (Array.isArray(choices) && choices.length > 0 && isRecord(choices[0])) {
    const choice = choices[0];

    const delta = choice.delta;
    if (isRecord(delta)) {
      const content = asString(delta.content);
      if (content !== undefined && content.length > 0) {
        return [{ type: "token", content }];
      }
    }

    const finishReason = asString(choice.finish_reason);
    if (finishReason !== undefined) {
      const usage = asTokenUsage(payload.usage) ?? createDefaultUsage();
      return [{ type: "done", usage, finishReason }];
    }
  }

  return [{ type: "error", error: new Error("Unknown stream payload format") }];
}

async function* readTextChunks(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  if (signal?.aborted) {
    return;
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();

  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      if (value === undefined) {
        continue;
      }

      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        yield text;
      }
    }

    const trailing = decoder.decode();
    if (!signal?.aborted && trailing.length > 0) {
      yield trailing;
    }
  } finally {
    if (signal?.aborted) {
      await reader.cancel();
    }
    reader.releaseLock();
  }
}

export class StreamTransformer {
  public static async *fromSSE(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    let buffer = "";

    for await (const chunk of readTextChunks(stream, signal)) {
      if (signal?.aborted) {
        return;
      }

      buffer += chunk;
      const separator = /\r?\n\r?\n/;
      let match = separator.exec(buffer);

      while (match !== null) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);

        const lines = block.split(/\r?\n/);
        const dataLines: string[] = [];
        let eventName: string | null = null;

        for (const line of lines) {
          if (line.startsWith("event:")) {
            const parsedEventName = line.slice(6).trim();
            eventName = parsedEventName.length > 0 ? parsedEventName : null;
            continue;
          }

          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        if (dataLines.length === 0) {
          match = separator.exec(buffer);
          continue;
        }

        const payloadText = dataLines.join("\n").trim();

        if (payloadText === "[DONE]") {
          yield { type: "done", usage: createDefaultUsage(), finishReason: "stop" };
          match = separator.exec(buffer);
          continue;
        }

        try {
          const parsed = JSON.parse(payloadText) as unknown;
          const normalizedPayload =
            eventName && isRecord(parsed) && asString(parsed.type) === undefined
              ? { ...parsed, type: eventName }
              : parsed;

          for (const event of normalizeParsedEvent(normalizedPayload)) {
            yield event;
          }
        } catch (error) {
          yield {
            type: "error",
            error: toError(error),
          };
        }

        match = separator.exec(buffer);
      }
    }

    const trailing = buffer.trim();
    if (trailing.length > 0) {
      yield {
        type: "error",
        error: new Error("Incomplete SSE event payload"),
      };
    }
  }

  public static async *fromNDJSON(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    let buffer = "";

    for await (const chunk of readTextChunks(stream, signal)) {
      if (signal?.aborted) {
        return;
      }

      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");

      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          if (line === "[DONE]") {
            yield { type: "done", usage: createDefaultUsage(), finishReason: "stop" };
          } else {
            try {
              const parsed = JSON.parse(line) as unknown;
              for (const event of normalizeParsedEvent(parsed)) {
                yield event;
              }
            } catch (error) {
              yield { type: "error", error: toError(error) };
            }
          }
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    const trailing = buffer.trim();
    if (trailing.length === 0) {
      return;
    }

    if (trailing === "[DONE]") {
      yield { type: "done", usage: createDefaultUsage(), finishReason: "stop" };
      return;
    }

    try {
      const parsed = JSON.parse(trailing) as unknown;
      for (const event of normalizeParsedEvent(parsed)) {
        yield event;
      }
    } catch (error) {
      yield { type: "error", error: toError(error) };
    }
  }

  public static async *fromChunkedText(
    stream: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<StreamEvent> {
    for await (const chunk of readTextChunks(stream, signal)) {
      if (signal?.aborted) {
        return;
      }

      if (chunk.length > 0) {
        yield { type: "token", content: chunk };
      }
    }

    if (!signal?.aborted) {
      yield { type: "done", usage: createDefaultUsage(), finishReason: "stop" };
    }
  }
}
