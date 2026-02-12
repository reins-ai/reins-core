import { afterEach, describe, expect, it } from "bun:test";

import { BYOKOpenAIProvider } from "../../../src/providers/byok/openai";
import type { ChatRequest, StreamEvent } from "../../../src/types";

const originalFetch = globalThis.fetch;

const makeRequest = (): ChatRequest => ({
  model: "gpt-4o-mini",
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

describe("BYOKOpenAIProvider", () => {
  it("returns normalized ChatResponse from OpenAI payload", async () => {
    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          id: "chatcmpl_123",
          model: "gpt-4o-mini",
          choices: [
            {
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Hi there",
              },
            },
          ],
          usage: {
            prompt_tokens: 11,
            completion_tokens: 9,
            total_tokens: 20,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKOpenAIProvider("openai-key", { baseUrl: "https://api.openai.test" });
    const response = await provider.chat(makeRequest());

    expect(response.id).toBe("chatcmpl_123");
    expect(response.content).toBe("Hi there");
    expect(response.usage.totalTokens).toBe(20);
    expect(response.finishReason).toBe("stop");
    expect(capturedHeaders).toMatchObject({ authorization: "Bearer openai-key" });
  });

  it("streams StreamEvents from OpenAI SSE", async () => {
    globalThis.fetch = async () => {
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

    const provider = new BYOKOpenAIProvider("openai-key", { baseUrl: "https://api.openai.test" });
    const events = await collectEvents(provider.stream(makeRequest()));

    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("lists models from OpenAI endpoint", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-4o-mini" }, { id: "gpt-4.1" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const provider = new BYOKOpenAIProvider("openai-key", { baseUrl: "https://api.openai.test" });
    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual(["gpt-4o-mini", "gpt-4.1"]);
  });

  it("validates connection using model listing", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    const provider = new BYOKOpenAIProvider("openai-key", { baseUrl: "https://api.openai.test" });
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
