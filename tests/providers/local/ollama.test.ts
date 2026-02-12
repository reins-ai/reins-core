import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ProviderError } from "../../../src/errors";
import { OllamaProvider } from "../../../src/providers/local/ollama";
import type { ChatRequest, Message, StreamEvent } from "../../../src/types";

const encoder = new TextEncoder();

const createMessage = (role: Message["role"], content: string): Message => ({
  id: `${role}-${content}`,
  role,
  content,
  createdAt: new Date(),
});

const createRequest = (): ChatRequest => ({
  model: "llama3.1:8b",
  systemPrompt: "Be helpful",
  messages: [createMessage("user", "Hello local model")],
});

const collectEvents = async (stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
};

const createNdjsonStream = (lines: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(`${line}\n`));
      }
      controller.close();
    },
  });

describe("OllamaProvider", () => {
  const originalFetch = globalThis.fetch;
  const capturedRequests: Array<{ url: string; body?: string }> = [];

  beforeEach(() => {
    capturedRequests.length = 0;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("parses model list from /api/tags", async () => {
    globalThis.fetch = async (input) => {
      capturedRequests.push({ url: String(input) });
      return new Response(
        JSON.stringify({
          models: [
            {
              name: "llama3.1:8b",
              size: 4_200,
              details: { parameter_size: "8B", family: "llama" },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new OllamaProvider({ baseUrl: "http://localhost:11434" });
    const models = await provider.listModels();

    expect(capturedRequests[0]?.url).toContain("/api/tags");
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "llama3.1:8b",
      name: "llama3.1:8b",
      provider: "ollama",
    });
    expect(models[0]?.capabilities).toContain("chat");
    expect(models[0]?.capabilities).toContain("streaming");
  });

  it("converts messages and parses chat response", async () => {
    globalThis.fetch = async (input, init) => {
      capturedRequests.push({
        url: String(input),
        body: typeof init?.body === "string" ? init.body : undefined,
      });

      return new Response(
        JSON.stringify({
          model: "llama3.1:8b",
          message: { role: "assistant", content: "Hello from Ollama" },
          prompt_eval_count: 12,
          eval_count: 6,
          eval_duration: 500_000_000,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new OllamaProvider();
    const response = await provider.chat(createRequest());

    const payload = JSON.parse(capturedRequests[0]?.body ?? "{}") as {
      stream?: boolean;
      messages?: Array<{ role: string; content: string }>;
    };

    expect(capturedRequests[0]?.url).toContain("/api/chat");
    expect(payload.stream).toBe(false);
    expect(payload.messages?.[0]).toEqual({ role: "system", content: "Be helpful" });
    expect(payload.messages?.[1]).toEqual({ role: "user", content: "Hello local model" });
    expect(response.content).toBe("Hello from Ollama");
    expect(response.usage).toEqual({ inputTokens: 12, outputTokens: 6, totalTokens: 18 });
    expect(response.finishReason).toBe("stop");
  });

  it("streams NDJSON token events and done event", async () => {
    globalThis.fetch = async () => {
      return new Response(
        createNdjsonStream([
          JSON.stringify({ message: { content: "Hel" }, done: false }),
          JSON.stringify({ message: { content: "lo" }, done: false }),
          JSON.stringify({ done: true, prompt_eval_count: 9, eval_count: 2, eval_duration: 200_000_000 }),
        ]),
        {
          status: 200,
          headers: { "content-type": "application/x-ndjson" },
        },
      );
    };

    const provider = new OllamaProvider();
    const events = await collectEvents(provider.stream(createRequest()));

    expect(events[0]).toEqual({ type: "token", content: "Hel" });
    expect(events[1]).toEqual({ type: "token", content: "lo" });
    expect(events[2]).toEqual({
      type: "done",
      usage: { inputTokens: 9, outputTokens: 2, totalTokens: 11 },
      finishReason: "stop",
    });
  });

  it("returns true or false from validateConnection", async () => {
    let healthy = true;

    globalThis.fetch = async () => {
      return new Response(JSON.stringify({ models: [] }), { status: healthy ? 200 : 500 });
    };

    const provider = new OllamaProvider();
    await expect(provider.validateConnection()).resolves.toBe(true);

    healthy = false;
    await expect(provider.validateConnection()).resolves.toBe(false);
  });

  it("handles connection failures gracefully", async () => {
    globalThis.fetch = async () => {
      throw new Error("connection refused");
    };

    const provider = new OllamaProvider();

    await expect(provider.listModels()).rejects.toThrow(ProviderError);

    const events = await collectEvents(provider.stream(createRequest()));
    expect(events[0]?.type).toBe("error");
    expect(events[1]).toEqual({
      type: "done",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "error",
    });
  });
});
