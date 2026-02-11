import { describe, expect, it } from "bun:test";

import { StreamingResponse } from "../../src/streaming";
import type { StreamEvent, TokenUsage, ToolCall } from "../../src/types";

const usage: TokenUsage = {
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
};

const toolCall: ToolCall = {
  id: "tool-1",
  name: "calendar.create",
  arguments: { title: "Standup" },
};

async function* eventStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

describe("StreamingResponse", () => {
  it("iterates through stream events", async () => {
    const events: StreamEvent[] = [
      { type: "token", content: "H" },
      { type: "token", content: "i" },
      { type: "done", usage, finishReason: "stop" },
    ];

    const response = new StreamingResponse(eventStream(events));
    const received: StreamEvent[] = [];

    for await (const event of response) {
      received.push(event);
    }

    expect(received).toEqual(events);
  });

  it("collects full response content and metadata", async () => {
    const events: StreamEvent[] = [
      { type: "token", content: "Hello" },
      { type: "token", content: " world" },
      { type: "tool_call_start", toolCall },
      {
        type: "tool_call_end",
        result: {
          callId: "tool-1",
          name: "calendar.create",
          result: { success: true },
        },
      },
      { type: "done", usage, finishReason: "stop" },
    ];

    const response = new StreamingResponse(eventStream(events));
    const collected = await response.collect();

    expect(collected.content).toBe("Hello world");
    expect(collected.toolCalls).toEqual([toolCall]);
    expect(collected.usage).toEqual(usage);
    expect(collected.finishReason).toBe("stop");
  });

  it("invokes registered callbacks for stream events", async () => {
    const events: StreamEvent[] = [
      { type: "token", content: "A" },
      { type: "tool_call_start", toolCall },
      { type: "error", error: new Error("stream warning") },
      { type: "done", usage, finishReason: "stop" },
    ];

    const seenTokens: string[] = [];
    const seenTools: ToolCall[] = [];
    const seenErrors: string[] = [];
    const doneStates: string[] = [];

    const response = new StreamingResponse(eventStream(events))
      .onToken((token) => seenTokens.push(token))
      .onToolCall((call) => seenTools.push(call))
      .onError((error) => seenErrors.push(error.message))
      .onDone((eventUsage, finishReason) => {
        doneStates.push(`${finishReason}:${eventUsage.totalTokens}`);
      });

    await response.collect();

    expect(seenTokens).toEqual(["A"]);
    expect(seenTools).toEqual([toolCall]);
    expect(seenErrors).toEqual(["stream warning"]);
    expect(doneStates).toEqual(["stop:15"]);
  });

  it("cancels stream via cancel()", async () => {
    async function* cancellableStream(): AsyncIterable<StreamEvent> {
      yield { type: "token", content: "1" };
      yield { type: "token", content: "2" };
      yield { type: "token", content: "3" };
      yield { type: "done", usage, finishReason: "stop" };
    }

    const response = new StreamingResponse(cancellableStream());
    const received: StreamEvent[] = [];

    for await (const event of response) {
      received.push(event);
      if (event.type === "token" && event.content === "1") {
        response.cancel();
      }
    }

    expect(response.aborted).toBe(true);
    expect(received).toEqual([{ type: "token", content: "1" }]);
  });

  it("honors external abort signal", async () => {
    const controller = new AbortController();

    async function* externalAbortStream(): AsyncIterable<StreamEvent> {
      yield { type: "token", content: "A" };
      yield { type: "token", content: "B" };
      yield { type: "done", usage, finishReason: "stop" };
    }

    const response = new StreamingResponse(externalAbortStream(), controller.signal);
    const received: StreamEvent[] = [];

    for await (const event of response) {
      received.push(event);
      if (event.type === "token") {
        controller.abort();
      }
    }

    expect(response.aborted).toBe(true);
    expect(received).toEqual([{ type: "token", content: "A" }]);
  });

  it("emits transcript records without token noise by default", async () => {
    const transcriptTypes: string[] = [];
    const events: StreamEvent[] = [
      { type: "token", content: "Hello" },
      { type: "token", content: " world" },
      { type: "tool_call_start", toolCall },
      {
        type: "tool_call_end",
        result: {
          callId: "tool-1",
          name: "calendar.create",
          result: { success: true },
        },
      },
      { type: "done", usage, finishReason: "stop" },
    ];

    const response = new StreamingResponse(eventStream(events), {
      turn: {
        turnId: "turn_1",
        model: "gpt-4o-mini",
        provider: "openai",
      },
      onTranscript: async (entry) => {
        transcriptTypes.push(entry.type);
      },
    });

    await response.collect();

    expect(transcriptTypes).toEqual(["turn_start", "tool_call", "tool_result", "message", "turn_end"]);
  });
});
