import { describe, expect, it } from "bun:test";

import { StreamTransformer } from "../../src/streaming";
import type { StreamEvent } from "../../src/types";

const encoder = new TextEncoder();

const collectEvents = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

const createByteStream = (chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });

describe("StreamTransformer", () => {
  it("parses SSE events and [DONE] marker", async () => {
    const sse = createByteStream([
      'data: {"type":"token","content":"Hi"}\n\n',
      'data: {"type":"done","usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2},"finishReason":"stop"}\n\n',
      "data: [DONE]\n\n",
    ]);

    const events = await collectEvents(StreamTransformer.fromSSE(sse));

    expect(events).toEqual([
      { type: "token", content: "Hi" },
      {
        type: "done",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        finishReason: "stop",
      },
      {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      },
    ]);
  });

  it("handles SSE partial chunks split across boundaries", async () => {
    const sse = createByteStream([
      "data: {\"type\":\"tok",
      "en\",\"content\":\"A\"}\n",
      "\n",
      "data: [DONE]\n\n",
    ]);

    const events = await collectEvents(StreamTransformer.fromSSE(sse));

    expect(events[0]).toEqual({ type: "token", content: "A" });
    expect(events[1]).toEqual({
      type: "done",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    });
  });

  it("parses Anthropic SSE delta events", async () => {
    const sse = createByteStream([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":12}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);

    const events = await collectEvents(StreamTransformer.fromSSE(sse));

    expect(events).toEqual([
      { type: "token", content: "Hello" },
      { type: "token", content: " world" },
      {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 5, totalTokens: 5 },
        finishReason: "end_turn",
      },
      {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      },
    ]);
  });

  it("parses NDJSON events", async () => {
    const ndjson = createByteStream([
      '{"type":"token","content":"Hello"}\n',
      '{"type":"token","content":" world"}\n',
      '{"type":"done","usage":{"inputTokens":2,"outputTokens":2,"totalTokens":4},"finishReason":"stop"}\n',
    ]);

    const events = await collectEvents(StreamTransformer.fromNDJSON(ndjson));

    expect(events).toEqual([
      { type: "token", content: "Hello" },
      { type: "token", content: " world" },
      {
        type: "done",
        usage: { inputTokens: 2, outputTokens: 2, totalTokens: 4 },
        finishReason: "stop",
      },
    ]);
  });

  it("parses chunked text into token events", async () => {
    const text = createByteStream(["Hel", "lo", " ", "world"]);

    const events = await collectEvents(StreamTransformer.fromChunkedText(text));

    expect(events).toEqual([
      { type: "token", content: "Hel" },
      { type: "token", content: "lo" },
      { type: "token", content: " " },
      { type: "token", content: "world" },
      {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        finishReason: "stop",
      },
    ]);
  });

  it("yields error events for malformed SSE/NDJSON payloads", async () => {
    const malformedSse = createByteStream(["data: {not-json}\n\n"]);
    const malformedNdjson = createByteStream(["{still-not-json}\n"]);

    const sseEvents = await collectEvents(StreamTransformer.fromSSE(malformedSse));
    const ndjsonEvents = await collectEvents(StreamTransformer.fromNDJSON(malformedNdjson));

    expect(sseEvents).toHaveLength(1);
    expect(sseEvents[0]?.type).toBe("error");
    expect(ndjsonEvents).toHaveLength(1);
    expect(ndjsonEvents[0]?.type).toBe("error");
  });

  it("supports cancellation with AbortSignal", async () => {
    const controller = new AbortController();
    const text = createByteStream(["A", "B", "C"]);

    const received: StreamEvent[] = [];
    for await (const event of StreamTransformer.fromChunkedText(text, controller.signal)) {
      received.push(event);
      controller.abort();
    }

    expect(received).toEqual([{ type: "token", content: "A" }]);
  });
});
