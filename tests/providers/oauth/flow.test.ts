import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderAuthService } from "../../../src/providers/auth-service";
import { EncryptedCredentialStore } from "../../../src/providers/credentials/store";
import { OAuthFlowHandler } from "../../../src/providers/oauth/flow";
import { ProviderRegistry } from "../../../src/providers/registry";
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

  it("supports overriding redirect URI for runtime callback sessions", () => {
    const handler = new OAuthFlowHandler(oauthConfig);

    const url = new URL(
      handler.getAuthorizationUrl("state-runtime", {
        redirectUri: "http://127.0.0.1:9000/oauth/callback",
      }),
    );

    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:9000/oauth/callback");
  });

  it("exchanges authorization code for OAuth tokens", async () => {
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(init?.method).toBe("POST");
      expect(body.grant_type).toBe("authorization_code");
      expect(body.code).toBe("auth-code");
      expect(body.client_id).toBe(oauthConfig.clientId);
      expect(body.client_secret).toBe(oauthConfig.clientSecret);
      expect(body.redirect_uri).toBe(oauthConfig.redirectUri);

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
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.grant_type).toBe("refresh_token");
      expect(body.refresh_token).toBe("old-refresh");

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

  it("completes runtime callback flow before token exchange", async () => {
    const handler = new OAuthFlowHandler(oauthConfig);
    const session = OAuthFlowHandler.startLocalCallbackServer({
      host: "127.0.0.1",
      callbackPath: "/oauth/callback",
      timeoutMs: 5_000,
    });

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.startsWith("https://auth.example.com/token")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        expect(body.grant_type).toBe("authorization_code");
        expect(body.code).toBe("runtime-code");
        expect(body.redirect_uri).toBe(session.redirectUri);

        return new Response(
          JSON.stringify({
            access_token: "runtime-access-token",
            refresh_token: "runtime-refresh-token",
            expires_in: 1800,
            scope: "chat:read chat:write",
            token_type: "Bearer",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return originalFetch(input, init);
    };

    try {
      const authorizationUrl = new URL(
        handler.getAuthorizationUrl("runtime-state", {
          redirectUri: session.redirectUri,
        }),
      );
      expect(authorizationUrl.searchParams.get("redirect_uri")).toBe(session.redirectUri);

      const callbackPromise = session.waitForCallback("runtime-state");
      const callbackResponse = await originalFetch(
        `${session.redirectUri}?code=runtime-code&state=runtime-state`,
      );

      expect(callbackResponse.status).toBe(200);

      const callback = await callbackPromise;
      const tokens = await handler.exchangeCode(callback.code, {
        redirectUri: session.redirectUri,
      });

      expect(tokens.accessToken).toBe("runtime-access-token");
      expect(tokens.refreshToken).toBe("runtime-refresh-token");
    } finally {
      session.stop();
    }
  });

  it("wires runtime OAuth initiation and callback completion through auth service", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "reins-oauth-runtime-"));
    const store = new EncryptedCredentialStore({
      encryptionSecret: "oauth-runtime-secret",
      filePath: join(tempDirectory, "credentials.enc.json"),
    });

    try {
      const handler = new OAuthFlowHandler(oauthConfig);
      const strategy = {
        mode: "oauth" as const,
        async initiate(context: {
          provider: string;
          register?: { state?: string; codeVerifier?: string; redirectUri?: string };
        }) {
          const state = context.register?.state ?? "service-runtime-state";
          return {
            ok: true as const,
            value: {
              type: "authorization_code" as const,
              authorizationUrl: handler.getAuthorizationUrl(state, {
                redirectUri: context.register?.redirectUri,
              }),
              state,
              codeVerifier: context.register?.codeVerifier,
            },
          };
        },
        async handleCallback(context: { code: string; state?: string }) {
          return {
            ok: true as const,
            value: {
              accessToken: `service-${context.code}`,
              refreshToken: "service-refresh",
              expiresAt: new Date(Date.now() + 3_600_000),
              scope: "chat:read chat:write",
              tokenType: "Bearer",
            },
          };
        },
        async refresh() {
          throw new Error("not used");
        },
        async storeTokens() {
          return { ok: true as const, value: undefined };
        },
        async retrieveTokens() {
          return { ok: true as const, value: null };
        },
        async revoke() {
          return { ok: true as const, value: undefined };
        },
      };

      const registry = new ProviderRegistry();
      registry.registerCapabilities("test-oauth-provider", {
        authModes: ["oauth"],
        requiresAuth: true,
        userConfigurable: true,
      });

      const service = new ProviderAuthService({
        store,
        registry,
        oauthStrategies: {
          "test-oauth-provider": strategy,
        },
      });

      const initiateResult = await service.initiateOAuth("test-oauth-provider", {
        localCallback: {
          host: "127.0.0.1",
          callbackPath: "/oauth/callback",
          timeoutMs: 5_000,
        },
      });

      expect(initiateResult.ok).toBe(true);
      if (!initiateResult.ok || initiateResult.value.type !== "authorization_code") {
        return;
      }

      const authorizationUrl = new URL(initiateResult.value.authorizationUrl);
      const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
      const state = authorizationUrl.searchParams.get("state");

      expect(redirectUri).toContain("127.0.0.1");
      expect(state).toBeTruthy();

      const completePromise = service.completeOAuthCallback("test-oauth-provider");
      const callbackResponse = await originalFetch(
        `${redirectUri}?code=service-runtime-code&state=${state}`,
      );
      expect(callbackResponse.status).toBe(200);

      const completeResult = await completePromise;
      expect(completeResult.ok).toBe(true);
      if (!completeResult.ok) {
        return;
      }

      expect(completeResult.value.accessToken).toBe("service-service-runtime-code");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
