import { describe, expect, it } from "bun:test";

import { createHarnessEventBus, EventTransportAdapter } from "../../src/harness";
import { StreamTransformer } from "../../src/streaming/transformer";

function toReadableStream(value: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(value));
      controller.close();
    },
  });
}

describe("EventTransportAdapter", () => {
  it("emits monotonic sequence IDs for harness events", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({
      eventBus: bus,
      replayLimit: 64,
    });

    const frames: Array<{ id: number; event: string; data: string; timestamp: number }> = [];
    adapter.onFrame((frame) => {
      frames.push(frame);
    });

    adapter.start();

    await bus.emit("message_start", {
      conversationId: "conv_1",
      messageId: "msg_1",
      model: "claude-sonnet-4",
    });
    await bus.emit("token", { content: "Hello" });
    await bus.emit("tool_call_start", {
      toolCall: {
        id: "tool_1",
        name: "notes.create",
        arguments: { title: "Plan" },
      },
    });
    await bus.emit("tool_call_end", {
      result: {
        callId: "tool_1",
        name: "notes.create",
        result: { id: "note_1" },
      },
    });
    await bus.emit("compaction", {
      summary: "Compacted old context",
      beforeTokenEstimate: 12000,
      afterTokenEstimate: 3800,
    });
    await bus.emit("done", {
      usage: {
        inputTokens: 120,
        outputTokens: 50,
        totalTokens: 170,
      },
      finishReason: "stop",
    });

    expect(frames.map((frame) => frame.id)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(frames.map((frame) => frame.event)).toEqual([
      "message_start",
      "token",
      "tool_call_start",
      "tool_call_end",
      "compaction",
      "done",
    ]);

    const tokenPayload = JSON.parse(frames[1].data) as { content: string };
    expect(tokenPayload.content).toBe("Hello");

    const replayAll = adapter.getReplayBuffer();
    const replaySinceThree = adapter.getReplayBuffer(3);
    expect(replayAll).toHaveLength(6);
    expect(replaySinceThree.map((frame) => frame.id)).toEqual([4, 5, 6]);

    adapter.stop();
  });

  it("serializes Error payloads to JSON-safe transport frames", async () => {
    const bus = createHarnessEventBus();
    const adapter = new EventTransportAdapter({ eventBus: bus });
    const frames: Array<{ id: number; event: string; data: string; timestamp: number }> = [];
    adapter.onFrame((frame) => {
      frames.push(frame);
    });

    adapter.start();
    await bus.emit("error", {
      error: new Error("transport-failure"),
      code: "TRANSPORT_FAILURE",
      retryable: true,
    });

    expect(frames).toHaveLength(1);
    const payload = JSON.parse(frames[0].data) as {
      error: { name: string; message: string; stack?: string };
      code: string;
      retryable: boolean;
    };

    expect(payload.error.name).toBe("Error");
    expect(payload.error.message).toBe("transport-failure");
    expect(payload.code).toBe("TRANSPORT_FAILURE");
    expect(payload.retryable).toBe(true);
  });

  it("round-trips SSE framing", () => {
    const frame = {
      id: 42,
      event: "token",
      data: '{"content":"hello"}',
      timestamp: 1700000000000,
    };

    const sse = EventTransportAdapter.toSSE(frame);
    const parsed = EventTransportAdapter.fromSSE(sse);

    expect(parsed).not.toBeNull();
    expect(parsed?.id).toBe(42);
    expect(parsed?.event).toBe("token");
    expect(parsed?.data).toBe('{"content":"hello"}');
  });
});

describe("StreamTransformer SSE compatibility", () => {
  it("decodes adapter SSE frames into typed stream events", async () => {
    const ssePayload = [
      EventTransportAdapter.toSSE({
        id: 1,
        event: "message_start",
        data: JSON.stringify({
          conversationId: "conv_1",
          messageId: "msg_1",
          model: "claude-sonnet-4",
        }),
        timestamp: 1700000000000,
      }),
      EventTransportAdapter.toSSE({
        id: 2,
        event: "token",
        data: JSON.stringify({ content: "Hello" }),
        timestamp: 1700000000001,
      }),
      EventTransportAdapter.toSSE({
        id: 3,
        event: "compaction",
        data: JSON.stringify({
          summary: "Compacted",
          beforeTokenEstimate: 5000,
          afterTokenEstimate: 3000,
        }),
        timestamp: 1700000000002,
      }),
      EventTransportAdapter.toSSE({
        id: 4,
        event: "done",
        data: JSON.stringify({
          usage: {
            inputTokens: 12,
            outputTokens: 8,
            totalTokens: 20,
          },
          finishReason: "stop",
        }),
        timestamp: 1700000000003,
      }),
    ].join("");

    const events = [] as string[];
    for await (const event of StreamTransformer.fromSSE(toReadableStream(ssePayload))) {
      events.push(event.type);
    }

    expect(events).toEqual(["message_start", "token", "compaction", "done"]);
  });
});
