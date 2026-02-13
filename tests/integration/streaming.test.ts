import { describe, expect, it } from "bun:test";

import { MockProvider } from "../../src/providers/mock";
import { StreamingResponse } from "../../src/streaming";
import type { ChatRequest, StreamEvent, ToolCall } from "../../src/types";

const createRequest = (): ChatRequest => ({
  model: "mock-model-1",
  messages: [
    {
      id: "msg-1",
      role: "user",
      content: "hello",
      createdAt: new Date(),
    },
  ],
});

const collectEvents = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

describe("integration/streaming", () => {
  it("streams tokens through callbacks and collect()", async () => {
    const provider = new MockProvider({ responseContent: "streaming works" });
    const seenTokens: string[] = [];

    const stream = new StreamingResponse(provider.stream(createRequest())).onToken((token) => {
      seenTokens.push(token);
    });

    const collected = await stream.collect();

    expect(seenTokens.join("")).toBe("streaming works");
    expect(collected.content).toBe("streaming works");
    expect(collected.finishReason).toBe("stop");
    expect(collected.usage.totalTokens).toBeGreaterThan(0);
  });

  it("supports cancellation with partial collected content", async () => {
    const provider = new MockProvider({ responseContent: "0123456789" });
    const received: string[] = [];

    const stream = new StreamingResponse(provider.stream(createRequest())).onToken((token) => {
      received.push(token);
      if (received.length === 4) {
        stream.cancel();
      }
    });

    const collected = await stream.collect();

    expect(stream.aborted).toBe(true);
    expect(received.join("")).toBe("0123");
    expect(collected.content).toBe("0123");
    expect(collected.finishReason).toBe("cancelled");
  });

  it("emits tool call start/end stream events", async () => {
    const toolCall: ToolCall = {
      id: "tool-1",
      name: "get_weather",
      arguments: { location: "NYC" },
    };

    const provider = new MockProvider({
      responseContent: "Using tool",
      toolCalls: [toolCall],
      finishReason: "tool_use",
    });

    const events = await collectEvents(provider.stream(createRequest()));

    expect(events.some((event) => event.type === "tool_call_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_call_end")).toBe(true);
    const toolStart = events.find((event) => event.type === "tool_call_start");
    if (!toolStart || toolStart.type !== "tool_call_start") {
      throw new Error("Expected tool_call_start event");
    }
    expect(toolStart.toolCall.name).toBe("get_weather");
  });

  it("handles provider stream errors", async () => {
    const provider = new MockProvider({ simulateError: true, errorMessage: "stream failure" });
    const seenErrors: string[] = [];

    const stream = new StreamingResponse(provider.stream(createRequest())).onError((error) => {
      seenErrors.push(error.message);
    });

    const collected = await stream.collect();

    expect(seenErrors).toEqual(["stream failure"]);
    expect(collected.content).toBe("");
    expect(collected.finishReason).toBe("error");
  });
});
