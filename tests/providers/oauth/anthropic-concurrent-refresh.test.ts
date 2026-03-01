import { afterEach, describe, expect, it } from "bun:test";

import { AnthropicOAuthProvider } from "../../../src/providers/oauth/anthropic";
import { InMemoryOAuthTokenStore } from "../../../src/providers/oauth/token-store";
import type { OAuthConfig } from "../../../src/providers/oauth/types";

const originalFetch = globalThis.fetch;

const oauthConfig: OAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["messages:read", "messages:write"],
  redirectUri: "http://localhost:4444/oauth/callback",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Seed the in-memory store with an expired token so `getAccessToken()` triggers a refresh.
 */
async function seedExpiredToken(store: InMemoryOAuthTokenStore): Promise<void> {
  await store.save("anthropic", {
    accessToken: "expired-access",
    refreshToken: "original-refresh",
    expiresAt: new Date(Date.now() - 60_000),
    scope: "messages:read messages:write",
    tokenType: "Bearer",
  });
}

describe("AnthropicOAuthProvider concurrent refresh deduplication", () => {
  it("two concurrent getAccessToken() calls trigger exactly one refresh", async () => {
    let fetchCallCount = 0;

    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      fetchCallCount++;
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.grant_type).toBe("refresh_token");

      // Simulate network latency so both callers overlap
      await new Promise((resolve) => setTimeout(resolve, 50));

      return new Response(
        JSON.stringify({
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: 3600,
          scope: "messages:read messages:write",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const store = new InMemoryOAuthTokenStore();
    await seedExpiredToken(store);

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });

    // Launch two concurrent calls
    const [token1, token2] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(fetchCallCount).toBe(1);
    expect(token1).toBe("refreshed-access");
    expect(token2).toBe("refreshed-access");
  });

  it("both concurrent callers receive the same access token", async () => {
    globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, 50));

      return new Response(
        JSON.stringify({
          access_token: "shared-refreshed-token",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "messages:read messages:write",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const store = new InMemoryOAuthTokenStore();
    await seedExpiredToken(store);

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });

    const results = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(results[0]).toBe("shared-refreshed-token");
    expect(results[1]).toBe("shared-refreshed-token");
    expect(results[0]).toBe(results[1]);
  });

  it("if refresh fails, both callers receive the error", async () => {
    globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      await new Promise((resolve) => setTimeout(resolve, 50));

      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token has been revoked",
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    };

    const store = new InMemoryOAuthTokenStore();
    await seedExpiredToken(store);

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });

    const results = await Promise.allSettled([
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect(results[0].status).toBe("rejected");
    expect(results[1].status).toBe("rejected");

    if (results[0].status === "rejected") {
      expect((results[0].reason as Error).message).toContain("OAuth refresh failed");
    }
    if (results[1].status === "rejected") {
      expect((results[1].reason as Error).message).toContain("OAuth refresh failed");
    }
  });

  it("after failed refresh, subsequent call can retry", async () => {
    let callCount = 0;

    globalThis.fetch = async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
      callCount++;

      if (callCount === 1) {
        // First call fails
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Temporary failure",
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }

      // Second call succeeds
      return new Response(
        JSON.stringify({
          access_token: "retry-success-token",
          refresh_token: "retry-refresh",
          expires_in: 3600,
          scope: "messages:read messages:write",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const store = new InMemoryOAuthTokenStore();
    await seedExpiredToken(store);

    const provider = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });

    // First call should fail
    const firstResult = await provider.getAccessToken().catch((error: Error) => error);
    expect(firstResult).toBeInstanceOf(Error);
    expect((firstResult as Error).message).toContain("OAuth refresh failed");

    // refreshInFlight should be cleared, allowing a retry
    const retryToken = await provider.getAccessToken();
    expect(retryToken).toBe("retry-success-token");
    expect(callCount).toBe(2);
  });
});
