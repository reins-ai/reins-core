import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../src/errors";
import { MockProvider } from "../../src/providers/mock";
import type { ChatRequest, StreamEvent } from "../../src/types";

const makeRequest = (model = "mock-model-1"): ChatRequest => ({
  model,
  messages: [
    {
      id: "msg-1",
      role: "user",
      content: "Hello mock provider",
      createdAt: new Date(),
    },
  ],
  systemPrompt: "You are a test assistant",
});

const collectEvents = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

describe("MockProvider", () => {
  it("returns configurable chat response with token usage", async () => {
    const provider = new MockProvider({ responseContent: "Custom reply" });

    const response = await provider.chat(makeRequest());

    expect(response.model).toBe("mock-model-1");
    expect(response.content).toBe("Custom reply");
    expect(response.finishReason).toBe("stop");
    expect(response.usage.inputTokens).toBeGreaterThan(0);
    expect(response.usage.outputTokens).toBeGreaterThan(0);
    expect(response.usage.totalTokens).toBe(response.usage.inputTokens + response.usage.outputTokens);
  });

  it("streams token events character-by-character and ends with done", async () => {
    const provider = new MockProvider({ responseContent: "abc" });
    const events = await collectEvents(provider.stream(makeRequest()));

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ type: "token", content: "a" });
    expect(events[1]).toEqual({ type: "token", content: "b" });
    expect(events[2]).toEqual({ type: "token", content: "c" });
    expect(events[3]?.type).toBe("done");
  });

  it("supports simulated tool calls in chat and stream", async () => {
    const provider = new MockProvider({
      responseContent: "Calling tool",
      toolCalls: [{ id: "call-1", name: "calendar.create", arguments: { title: "Standup" } }],
    });

    const chatResponse = await provider.chat(makeRequest());
    const streamEvents = await collectEvents(provider.stream(makeRequest()));

    expect(chatResponse.finishReason).toBe("tool_use");
    expect(chatResponse.toolCalls).toHaveLength(1);
    expect(streamEvents.some((event) => event.type === "tool_call_start")).toBe(true);
    expect(streamEvents.some((event) => event.type === "tool_call_end")).toBe(true);
  });

  it("returns configurable model list", async () => {
    const provider = new MockProvider({
      config: { id: "custom" },
      models: [
        {
          id: "custom-model",
          name: "Custom Model",
          provider: "custom",
          contextWindow: 8192,
          capabilities: ["chat", "vision"],
        },
      ],
    });

    const models = await provider.listModels();

    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("custom-model");
    expect(models[0]?.capabilities).toEqual(["chat", "vision"]);
  });

  it("simulates errors for chat and listModels", async () => {
    const provider = new MockProvider({ simulateError: true, errorMessage: "Simulated failure" });

    await expect(provider.chat(makeRequest())).rejects.toThrow(ProviderError);
    await expect(provider.listModels()).rejects.toThrow(ProviderError);
  });

  it("emits error and done events in stream when simulateError is enabled", async () => {
    const provider = new MockProvider({ simulateError: true, errorMessage: "Stream failure" });

    const events = await collectEvents(provider.stream(makeRequest()));

    expect(events).toHaveLength(2);
    expect(events[0]?.type).toBe("error");
    expect(events[1]).toEqual({
      type: "done",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "error",
    });
  });

  it("validates connection successfully", async () => {
    const provider = new MockProvider();

    await expect(provider.validateConnection()).resolves.toBe(true);
  });

  it("throws when requested model does not exist", async () => {
    const provider = new MockProvider();

    await expect(provider.chat(makeRequest("missing-model"))).rejects.toThrow(ProviderError);
  });
});
