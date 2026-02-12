import { afterEach, describe, expect, it } from "bun:test";

import { OpenAIOAuthProvider } from "../../../src/providers/oauth/openai";
import { InMemoryOAuthTokenStore } from "../../../src/providers/oauth/token-store";
import type { OAuthConfig } from "../../../src/providers/oauth/types";
import type { ChatRequest, StreamEvent } from "../../../src/types";

const originalFetch = globalThis.fetch;

const oauthConfig: OAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["chat:read", "chat:write"],
  redirectUri: "http://localhost:4444/oauth/callback",
};

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

describe("OpenAIOAuthProvider", () => {
  it("returns normalized ChatResponse from OpenAI payload", async () => {
    const store = new InMemoryOAuthTokenStore();
    await store.save("openai", {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "chat:read",
      tokenType: "Bearer",
    });

    globalThis.fetch = async () =>
      new Response(
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

    const provider = new OpenAIOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.openai.test",
    });

    const response = await provider.chat(makeRequest());
    expect(response.id).toBe("chatcmpl_123");
    expect(response.content).toBe("Hi there");
    expect(response.usage.totalTokens).toBe(20);
    expect(response.finishReason).toBe("stop");
  });

  it("streams StreamEvents from OpenAI SSE", async () => {
    const store = new InMemoryOAuthTokenStore();
    await store.save("openai", {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "chat:read",
      tokenType: "Bearer",
    });

    globalThis.fetch = async () => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'),
          );
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });

      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };

    const provider = new OpenAIOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.openai.test",
    });

    const events = await collectEvents(provider.stream(makeRequest()));
    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("lists models from OpenAI endpoint", async () => {
    const store = new InMemoryOAuthTokenStore();
    await store.save("openai", {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "chat:read",
      tokenType: "Bearer",
    });

    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          data: [{ id: "gpt-4o-mini" }, { id: "gpt-4.1" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const provider = new OpenAIOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.openai.test",
    });

    const models = await provider.listModels();

    expect(models.map((model) => model.id)).toEqual(["gpt-4o-mini", "gpt-4.1"]);
  });
});

async function collectEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
