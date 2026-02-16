import { afterEach, describe, expect, it } from "bun:test";

import { AnthropicOAuthProvider } from "../../../src/providers/oauth/anthropic";
import { InMemoryOAuthTokenStore } from "../../../src/providers/oauth/token-store";
import type { OAuthConfig } from "../../../src/providers/oauth/types";
import type { ChatRequest, StreamEvent } from "../../../src/types";

const originalFetch = globalThis.fetch;

const oauthConfig: OAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["messages:read", "messages:write"],
  redirectUri: "http://localhost:4444/oauth/callback",
};

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

describe("AnthropicOAuthProvider", () => {
  it("initiates OAuth with PKCE and state", async () => {
    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: new InMemoryOAuthTokenStore(),
      baseUrl: "https://api.anthropic.test",
    });

    const result = await provider.strategy.initiate({ provider: "anthropic" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const authUrl = new URL(result.value.authorizationUrl);
    expect(authUrl.searchParams.get("state")).toBe(result.value.state);
    expect(authUrl.searchParams.get("code_challenge")).toBeTruthy();
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(result.value.codeVerifier).toBeTruthy();
  });

  it("exchanges callback code when state matches pending OAuth session", async () => {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("auth-code");
      expect(body.code_verifier?.length).toBeGreaterThan(20);

      return new Response(
        JSON.stringify({
          access_token: "oauth-access",
          refresh_token: "oauth-refresh",
          expires_in: 3600,
          scope: "messages:read messages:write",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: new InMemoryOAuthTokenStore(),
      baseUrl: "https://api.anthropic.test",
    });

    const initiateResult = await provider.strategy.initiate({ provider: "anthropic" });
    expect(initiateResult.ok).toBe(true);
    if (!initiateResult.ok) {
      return;
    }

    const callbackResult = await provider.strategy.handleCallback({
      provider: "anthropic",
      code: "auth-code",
      state: initiateResult.value.state,
    });

    expect(callbackResult.ok).toBe(true);
    if (!callbackResult.ok) {
      return;
    }

    expect(callbackResult.value.accessToken).toBe("oauth-access");
    expect(callbackResult.value.refreshToken).toBe("oauth-refresh");
  });

  it("rejects callback when token exchange fails with bad code", async () => {
    // In the code-paste flow, state validation happens implicitly during
    // token exchange — if the wrong verifier is used, exchange fails.
    globalThis.fetch = async (): Promise<Response> => {
      return new Response(
        JSON.stringify({ error: "invalid_grant", error_description: "Invalid authorization code" }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: new InMemoryOAuthTokenStore(),
      baseUrl: "https://api.anthropic.test",
    });

    const initiateResult = await provider.strategy.initiate({ provider: "anthropic" });
    expect(initiateResult.ok).toBe(true);
    if (!initiateResult.ok) {
      return;
    }

    const callbackResult = await provider.strategy.handleCallback({
      provider: "anthropic",
      code: "bad-code",
    });

    expect(callbackResult.ok).toBe(false);
    if (callbackResult.ok) {
      return;
    }

    expect(callbackResult.error.message).toContain("token exchange failed");
  });

  it("refreshes and persists OAuth tokens", async () => {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("refresh-token");

      return new Response(
        JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: 3600,
          scope: "messages:read",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const store = new InMemoryOAuthTokenStore();
    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });

    const refreshResult = await provider.strategy.refresh({
      provider: "anthropic",
      refreshToken: "refresh-token",
    });

    expect(refreshResult.ok).toBe(true);
    if (!refreshResult.ok) {
      return;
    }

    const stored = await store.load("anthropic");
    expect(stored?.accessToken).toBe("refreshed-access");
    expect(stored?.refreshToken).toBe("refreshed-refresh");
  });

  it("returns normalized ChatResponse from Anthropic payload", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const store = new InMemoryOAuthTokenStore();
    await store.save("anthropic", {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "messages:read",
      tokenType: "Bearer",
    });

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

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });

    const response = await provider.chat(makeRequest());

    expect(response.id).toBe("msg_123");
    expect(response.model).toBe("claude-3-5-sonnet-latest");
    expect(response.content).toBe("Hello back");
    expect(response.usage.totalTokens).toBe(17);
    expect(response.finishReason).toBe("stop");
    expect(capturedBody?.thinking).toBeUndefined();
    expect(capturedHeaders).toMatchObject({
      "anthropic-beta": expect.stringContaining("interleaved-thinking-2025-05-14"),
    });
  });

  it("includes thinking payload for chat requests", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const store = new InMemoryOAuthTokenStore();
    await store.save("anthropic", {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "messages:read",
      tokenType: "Bearer",
    });

    globalThis.fetch = async (_input, init) => {
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

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });

    await provider.chat({
      ...makeRequest(),
      thinkingLevel: "medium",
      maxTokens: 2000,
    });

    expect(capturedBody?.thinking).toEqual({ type: "enabled", budget_tokens: 1999 });
  });

  it("streams StreamEvents from SSE response", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const store = new InMemoryOAuthTokenStore();
    await store.save("anthropic", {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "messages:read",
      tokenType: "Bearer",
    });

    globalThis.fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
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

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });

    const events = await collectEvents(provider.stream(makeRequest()));
    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(capturedBody?.thinking).toBeUndefined();
  });

  it("includes thinking payload for stream requests", async () => {
    let capturedBody: Record<string, unknown> | undefined;

    const store = new InMemoryOAuthTokenStore();
    await store.save("anthropic", {
      accessToken: "valid-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scope: "messages:read",
      tokenType: "Bearer",
    });

    globalThis.fetch = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
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

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });

    const events = await collectEvents(provider.stream({
      ...makeRequest(),
      thinkingLevel: "high",
      maxTokens: 5000,
    }));

    expect(events.some((event) => event.type === "token")).toBe(true);
    expect(events.some((event) => event.type === "done")).toBe(true);
    expect(capturedBody?.thinking).toEqual({ type: "enabled", budget_tokens: 4999 });
    expect(capturedBody?.stream).toBe(true);
  });

  it("returns known Anthropic model list", async () => {
    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: new InMemoryOAuthTokenStore(),
    });

    const models = await provider.listModels();
    expect(models.length).toBeGreaterThanOrEqual(4);
    expect(models.some((model) => model.id === "anthropic/claude-sonnet-4-5")).toBe(true);
    expect(models.some((model) => model.id === "anthropic/claude-haiku-4-5")).toBe(true);
    expect(models.some((model) => model.id === "anthropic/claude-opus-4-5")).toBe(true);
    expect(models.some((model) => model.id === "anthropic/claude-opus-4-6")).toBe(true);
  });
});

async function collectEvents(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}
