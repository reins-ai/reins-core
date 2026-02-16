import { afterEach, describe, expect, it } from "bun:test";

import { BYOKAnthropicProvider } from "../../../src/providers/byok/anthropic";
import type { ChatRequest, StreamEvent } from "../../../src/types";

const originalFetch = globalThis.fetch;

const makeRequest = (): ChatRequest => ({
  model: "claude-3-5-sonnet-latest",
  messages: [
    {
      id: "msg-1",
      role: "user",
      content: "Hello",
      createdAt: new Date(),
    },
  ],
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("BYOKAnthropicProvider", () => {
  it("returns normalized ChatResponse from Anthropic payload", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "msg_123",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "Hello back" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 7,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("anthropic-key", { baseUrl: "https://api.anthropic.test" });
    const response = await provider.chat(makeRequest());

    expect(response.id).toBe("msg_123");
    expect(response.model).toBe("claude-3-5-sonnet-latest");
    expect(response.content).toBe("Hello back");
    expect(response.usage.totalTokens).toBe(17);
    expect(response.finishReason).toBe("stop");
    expect(capturedHeaders).toMatchObject({ "x-api-key": "anthropic-key" });
    expect(capturedBody?.thinking).toBeUndefined();
  });

  it("includes thinking payload and beta header for chat requests", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;

      return new Response(
        JSON.stringify({
          id: "msg_123",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "Hello back" }],
          stop_reason: "end_turn",
          usage: {
            input_tokens: 10,
            output_tokens: 7,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("anthropic-key", { baseUrl: "https://api.anthropic.test" });
    await provider.chat({
      ...makeRequest(),
      thinkingLevel: "high",
      maxTokens: 5000,
    });

    expect(capturedHeaders).toMatchObject({
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    });
    expect(capturedBody?.thinking).toEqual({ type: "enabled", budget_tokens: 4999 });
  });

  it("streams StreamEvents from SSE response", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedHeaders = init?.headers;
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const provider = new BYOKAnthropicProvider("anthropic-key", { baseUrl: "https://api.anthropic.test" });
    const events = await collectEvents(provider.stream({
      ...makeRequest(),
      thinkingLevel: "medium",
      maxTokens: 2000,
    }));

    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(capturedHeaders).toMatchObject({
      "anthropic-beta": "interleaved-thinking-2025-05-14",
    });
    expect(capturedBody?.thinking).toEqual({ type: "enabled", budget_tokens: 1999 });
    expect(capturedBody?.stream).toBe(true);
  });

  it("returns known Anthropic models", async () => {
    const provider = new BYOKAnthropicProvider("anthropic-key");
    const models = await provider.listModels();

    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(models.some((model) => model.id === "claude-3-5-sonnet-latest")).toBe(true);
  });

  it("validates connection with lightweight model call", async () => {
    globalThis.fetch = async () => new Response(null, { status: 200 });

    const provider = new BYOKAnthropicProvider("anthropic-key", { baseUrl: "https://api.anthropic.test" });
    await expect(provider.validateConnection()).resolves.toBe(true);
  });
});

async function collectEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
