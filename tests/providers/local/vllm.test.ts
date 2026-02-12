import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { VLLMProvider } from "../../../src/providers/local/vllm";
import type { ChatRequest, Message, StreamEvent } from "../../../src/types";

const encoder = new TextEncoder();

const createMessage = (role: Message["role"], content: string): Message => ({
  id: `${role}-${content}`,
  role,
  content,
  createdAt: new Date(),
});

const createRequest = (): ChatRequest => ({
  model: "Qwen/Qwen2.5-7B-Instruct",
  systemPrompt: "Be concise",
  messages: [createMessage("user", "Hello from vLLM")],
});

const collectEvents = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

const createSseStream = (blocks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const block of blocks) {
        controller.enqueue(encoder.encode(block));
      }
      controller.close();
    },
  });

describe("VLLMProvider", () => {
  const originalFetch = globalThis.fetch;
  const capturedRequests: Array<{ url: string; body?: string }> = [];

  beforeEach(() => {
    capturedRequests.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses models from OpenAI-compatible /v1/models", async () => {
    globalThis.fetch = async (input) => {
      capturedRequests.push({ url: String(input) });
      return new Response(
        JSON.stringify({
          data: [
            { id: "Qwen/Qwen2.5-7B-Instruct", owned_by: "vllm" },
            { id: "meta-llama/Meta-Llama-3.1-8B-Instruct", owned_by: "vllm" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new VLLMProvider({ baseUrl: "http://localhost:8000" });
    const models = await provider.listModels();

    expect(capturedRequests[0]?.url).toContain("/v1/models");
    expect(models).toHaveLength(2);
    expect(models[0]?.provider).toBe("vllm");
    expect(models[0]?.capabilities).toContain("streaming");
  });

  it("parses chat completion responses", async () => {
    globalThis.fetch = async (input, init) => {
      capturedRequests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      return new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          model: "Qwen/Qwen2.5-7B-Instruct",
          choices: [
            {
              message: {
                role: "assistant",
                content: "Hello from vLLM",
              },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new VLLMProvider();
    const response = await provider.chat(createRequest());

    const payload = JSON.parse(capturedRequests[0]?.body ?? "{}") as {
      stream?: boolean;
      messages?: Array<{ role: string; content: string }>;
    };

    expect(capturedRequests[0]?.url).toContain("/v1/chat/completions");
    expect(payload.stream).toBe(false);
    expect(payload.messages?.[0]).toEqual({ role: "system", content: "Be concise" });
    expect(response.content).toBe("Hello from vLLM");
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
  });

  it("streams token events from SSE payload", async () => {
    globalThis.fetch = async () => {
      return new Response(
        createSseStream([
          'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
          'data: {"choices":[{"finish_reason":"stop"}]}\n\n',
        ]),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    };

    const provider = new VLLMProvider();
    const events = await collectEvents(provider.stream(createRequest()));

    expect(events[0]).toEqual({ type: "token", content: "Hi" });
    expect(events[1]).toEqual({ type: "token", content: " there" });
    expect(events[2]?.type).toBe("done");
    if (events[2]?.type === "done") {
      expect(events[2].usage.totalTokens).toBeGreaterThan(0);
      expect(events[2].finishReason).toBe("stop");
    }
  });

  it("validates connection using /v1/models", async () => {
    let status = 200;

    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ data: [] }), { status });
    };

    const provider = new VLLMProvider();
    await expect(provider.validateConnection()).resolves.toBe(true);

    status = 503;
    await expect(provider.validateConnection()).resolves.toBe(false);
  });
});
