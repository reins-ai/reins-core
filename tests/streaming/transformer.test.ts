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

  it("parses Anthropic tool_use content blocks from SSE stream", async () => {
    const sse = createByteStream([
      'data: {"type":"message_start","message":{"id":"msg_123","role":"assistant","usage":{"input_tokens":50}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check."}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_abc123","name":"bash","input":{}}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"com"}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"mand\\": \\"ls\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);

    const events = await collectEvents(StreamTransformer.fromSSE(sse));

    expect(events).toEqual([
      { type: "token", content: "Let me check." },
      {
        type: "tool_call_start",
        toolCall: {
          id: "toolu_abc123",
          name: "bash",
          arguments: { command: "ls" },
        },
      },
      {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 30, totalTokens: 30 },
        finishReason: "tool_use",
      },
    ]);
  });

  it("parses multiple Anthropic tool_use blocks in a single response", async () => {
    const sse = createByteStream([
      'data: {"type":"message_start","message":{"id":"msg_456"}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_001","name":"read","input":{}}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"/tmp/a.txt\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_002","name":"write","input":{}}}\n\n',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\": \\"/tmp/b.txt\\", \\"content\\": \\"hello\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":1}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":15}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);

    const events = await collectEvents(StreamTransformer.fromSSE(sse));

    expect(events).toEqual([
      {
        type: "tool_call_start",
        toolCall: {
          id: "toolu_001",
          name: "read",
          arguments: { path: "/tmp/a.txt" },
        },
      },
      {
        type: "tool_call_start",
        toolCall: {
          id: "toolu_002",
          name: "write",
          arguments: { path: "/tmp/b.txt", content: "hello" },
        },
      },
      {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 15, totalTokens: 15 },
        finishReason: "tool_use",
      },
    ]);
  });

  it("handles tool_use block with empty input", async () => {
    const sse = createByteStream([
      'data: {"type":"message_start","message":{"id":"msg_789"}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_empty","name":"ls","input":{}}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":3}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);

    const events = await collectEvents(StreamTransformer.fromSSE(sse));

    expect(events).toEqual([
      {
        type: "tool_call_start",
        toolCall: {
          id: "toolu_empty",
          name: "ls",
          arguments: {},
        },
      },
      {
        type: "done",
        usage: { inputTokens: 0, outputTokens: 3, totalTokens: 3 },
        finishReason: "tool_use",
      },
    ]);
  });
});
