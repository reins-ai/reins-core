import { afterEach, describe, expect, it } from "bun:test";

import { BYOKGoogleProvider } from "../../../src/providers/byok/google";
import type { ChatRequest, StreamEvent } from "../../../src/types";

const originalFetch = globalThis.fetch;

const makeRequest = (): ChatRequest => ({
  model: "gemini-1.5-flash",
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

describe("BYOKGoogleProvider", () => {
  it("returns normalized ChatResponse from Gemini payload", async () => {
    let capturedHeaders: HeadersInit | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedHeaders = init?.headers;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ text: "Hello back" }],
              },
              finishReason: "STOP",
            },
          ],
          usageMetadata: {
            promptTokenCount: 9,
            candidatesTokenCount: 5,
            totalTokenCount: 14,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKGoogleProvider("google-key", {
      baseUrl: "https://generativelanguage.googleapis.test",
    });
    const response = await provider.chat(makeRequest());

    expect(response.model).toBe("gemini-1.5-flash");
    expect(response.content).toBe("Hello back");
    expect(response.usage.totalTokens).toBe(14);
    expect(response.finishReason).toBe("stop");
    expect(capturedHeaders).toMatchObject({ "x-goog-api-key": "google-key" });
  });

  it("streams StreamEvents from Gemini SSE", async () => {
    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              'data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\ndata: [DONE]\n\n',
            ),
          );
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const provider = new BYOKGoogleProvider("google-key", {
      baseUrl: "https://generativelanguage.googleapis.test",
    });
    const events = await collectEvents(provider.stream(makeRequest()));

    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("returns known Gemini model list", async () => {
    const provider = new BYOKGoogleProvider("google-key");
    const models = await provider.listModels();

    expect(models.length).toBeGreaterThanOrEqual(2);
    expect(models.some((model) => model.id === "gemini-1.5-flash")).toBe(true);
  });

  it("validates connection with Google models endpoint", async () => {
    globalThis.fetch = async () => new Response(null, { status: 200 });

    const provider = new BYOKGoogleProvider("google-key", {
      baseUrl: "https://generativelanguage.googleapis.test",
    });
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
