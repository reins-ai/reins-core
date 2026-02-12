import { afterEach, describe, expect, it } from "bun:test";

import { OAuthFlowHandler } from "../../../src/providers/oauth/flow";
import type { OAuthConfig, OAuthTokens } from "../../../src/providers/oauth/types";

const originalFetch = globalThis.fetch;

const oauthConfig: OAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["chat:read", "chat:write"],
  redirectUri: "http://localhost:4444/oauth/callback",
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OAuthFlowHandler", () => {
  it("generates authorization URL with required query parameters", () => {
    const handler = new OAuthFlowHandler(oauthConfig);

    const url = new URL(handler.getAuthorizationUrl("state-123"));

    expect(url.origin + url.pathname).toBe(oauthConfig.authorizationUrl);
    expect(url.searchParams.get("client_id")).toBe(oauthConfig.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(oauthConfig.redirectUri);
    expect(url.searchParams.get("scope")).toBe("chat:read chat:write");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("exchanges authorization code for OAuth tokens", async () => {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = String(init?.body ?? "");
      const params = new URLSearchParams(body);
      expect(init?.method).toBe("POST");
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("auth-code");
      expect(params.get("client_id")).toBe(oauthConfig.clientId);
      expect(params.get("client_secret")).toBe(oauthConfig.clientSecret);
      expect(params.get("redirect_uri")).toBe(oauthConfig.redirectUri);

      return new Response(
        JSON.stringify({
          access_token: "access-token",
          refresh_token: "refresh-token",
          expires_in: 1800,
          scope: "chat:read chat:write",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const handler = new OAuthFlowHandler(oauthConfig);
    const before = Date.now();
    const tokens = await handler.exchangeCode("auth-code");
    const after = Date.now();

    expect(tokens.accessToken).toBe("access-token");
    expect(tokens.refreshToken).toBe("refresh-token");
    expect(tokens.scope).toBe("chat:read chat:write");
    expect(tokens.tokenType).toBe("Bearer");
    expect(tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 1_799_000);
    expect(tokens.expiresAt.getTime()).toBeLessThanOrEqual(after + 1_801_000);
  });

  it("refreshes OAuth tokens with refresh_token grant", async () => {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const params = new URLSearchParams(String(init?.body ?? ""));
      expect(params.get("grant_type")).toBe("refresh_token");
      expect(params.get("refresh_token")).toBe("old-refresh");

      return new Response(
        JSON.stringify({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 3600,
          scope: "chat:read",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const handler = new OAuthFlowHandler(oauthConfig);
    const tokens = await handler.refreshTokens("old-refresh");

    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("new-refresh");
    expect(tokens.scope).toBe("chat:read");
  });

  it("detects expired and valid token windows with safety buffer", () => {
    const handler = new OAuthFlowHandler(oauthConfig);

    const expired: OAuthTokens = {
      accessToken: "expired",
      expiresAt: new Date(Date.now() + 60_000),
      scope: "chat:read",
      tokenType: "Bearer",
    };

    const valid: OAuthTokens = {
      accessToken: "valid",
      expiresAt: new Date(Date.now() + 10 * 60_000),
      scope: "chat:read",
      tokenType: "Bearer",
    };

    expect(handler.isExpired(expired)).toBe(true);
    expect(handler.isExpired(valid)).toBe(false);
  });

  it("generates PKCE verifier and challenge", () => {
    const handler = new OAuthFlowHandler(oauthConfig);
    const pkce = handler.generatePkcePair();

    expect(pkce.verifier.length).toBeGreaterThan(20);
    expect(pkce.challenge).toBe(OAuthFlowHandler.computePkceChallenge(pkce.verifier));
    expect(pkce.method).toBe("S256");
  });

  it("parses callback parameters and validates state", () => {
    const handler = new OAuthFlowHandler(oauthConfig);
    const callback = handler.parseCallbackParameters(
      "http://localhost:4444/oauth/callback?code=auth-code&state=state-123",
      "state-123",
    );

    expect(callback.code).toBe("auth-code");
    expect(callback.state).toBe("state-123");
  });

  it("rejects callback when state does not match", () => {
    const handler = new OAuthFlowHandler(oauthConfig);

    expect(() =>
      handler.parseCallbackParameters(
        "http://localhost:4444/oauth/callback?code=auth-code&state=unexpected",
        "expected",
      ),
    ).toThrow("state mismatch");
  });

  it("receives callback through local callback server", async () => {
    const handler = new OAuthFlowHandler(oauthConfig);
    const session = handler.startLocalCallbackServer({
      host: "127.0.0.1",
      callbackPath: "/oauth/callback",
      timeoutMs: 5_000,
    });

    try {
      const callbackPromise = session.waitForCallback("server-state");
      const response = await fetch(
        `${session.redirectUri}?code=server-code&state=server-state`,
      );
      expect(response.status).toBe(200);

      const callback = await callbackPromise;
      expect(callback.code).toBe("server-code");
      expect(callback.state).toBe("server-state");
    } finally {
      session.stop();
    }
  });
});
