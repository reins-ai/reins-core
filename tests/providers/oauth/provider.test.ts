import { describe, expect, it } from "bun:test";

import { AuthError } from "../../../src/errors";
import { AnthropicOAuthProvider } from "../../../src/providers/oauth/anthropic";
import { OAuthFlowHandler } from "../../../src/providers/oauth/flow";
import { glmOAuthProviderDefinition } from "../../../src/providers/oauth/glm";
import { GoogleOAuthProvider } from "../../../src/providers/oauth/google";
import { kimiOAuthProviderDefinition } from "../../../src/providers/oauth/kimi";
import { MiniMaxOAuthProvider } from "../../../src/providers/oauth/minimax";
import { OpenAIOAuthProvider } from "../../../src/providers/oauth/openai";
import { OAuthProvider, OAuthProviderRegistry } from "../../../src/providers/oauth/provider";
import { InMemoryOAuthTokenStore } from "../../../src/providers/oauth/token-store";
import type { OAuthConfig, OAuthTokens } from "../../../src/providers/oauth/types";

const oauthConfig: OAuthConfig = {
  clientId: "client-id",
  clientSecret: "client-secret",
  authorizationUrl: "https://auth.example.com/authorize",
  tokenUrl: "https://auth.example.com/token",
  scopes: ["chat:read"],
  redirectUri: "http://localhost:4444/oauth/callback",
};

class TestOAuthFlow extends OAuthFlowHandler {
  constructor(private readonly refreshedTokens?: OAuthTokens) {
    super(oauthConfig);
  }

  public override async refreshTokens(_refreshToken: string): Promise<OAuthTokens> {
    if (!this.refreshedTokens) {
      throw new Error("Refresh failed");
    }

    return this.refreshedTokens;
  }
}

class TestOAuthProvider extends OAuthProvider {
  protected readonly providerType = "openai" as const;

  constructor(store: InMemoryOAuthTokenStore, flow: OAuthFlowHandler) {
    super(oauthConfig, store, flow);
  }
}

function makeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    scope: "chat:read",
    tokenType: "Bearer",
    ...overrides,
  };
}

describe("OAuthProvider", () => {
  it("returns stored access token when token is valid", async () => {
    const store = new InMemoryOAuthTokenStore();
    await store.save("openai", makeTokens());

    const provider = new TestOAuthProvider(store, new TestOAuthFlow());

    await expect(provider.getAccessToken()).resolves.toBe("access-token");
  });

  it("auto-refreshes expired token and persists new tokens", async () => {
    const store = new InMemoryOAuthTokenStore();
    await store.save("openai", makeTokens({ expiresAt: new Date(Date.now() + 60 * 1000) }));

    const refreshed = makeTokens({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    const provider = new TestOAuthProvider(store, new TestOAuthFlow(refreshed));
    const accessToken = await provider.getAccessToken();

    expect(accessToken).toBe("new-access-token");
    expect(await store.load("openai")).toEqual(refreshed);
  });

  it("throws AuthError when tokens are missing", async () => {
    const store = new InMemoryOAuthTokenStore();
    const provider = new TestOAuthProvider(store, new TestOAuthFlow());

    await expect(provider.getAccessToken()).rejects.toThrow(AuthError);
  });

  it("disconnect clears tokens", async () => {
    const store = new InMemoryOAuthTokenStore();
    await store.save("openai", makeTokens());
    const provider = new TestOAuthProvider(store, new TestOAuthFlow());

    await provider.disconnect();

    expect(await store.load("openai")).toBeNull();
    expect(await provider.getConnectionStatus()).toBe("disconnected");
  });

  it("registers and resolves provider definitions from registry", () => {
    const registry = new OAuthProviderRegistry();
    registry.register(glmOAuthProviderDefinition);
    registry.register(kimiOAuthProviderDefinition);

    const providers = registry.list();
    expect(providers.map((provider) => provider.id)).toEqual(["glm", "kimi"]);
    expect(registry.getOrThrow("glm").metadata.apiKey?.envVar).toBe("ZAI_API_KEY");

    expect(() => registry.register(glmOAuthProviderDefinition)).toThrow(AuthError);
  });

  it("exposes extension contract methods on OAuth providers", async () => {
    const store = new InMemoryOAuthTokenStore();
    const anthropic = new AnthropicOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.anthropic.test",
    });
    const openai = new OpenAIOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.openai.test",
    });
    const google = new GoogleOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://cloudcode-pa.googleapis.test",
    });
    const minimax = new MiniMaxOAuthProvider({
      oauthConfig,
      tokenStore: store,
      baseUrl: "https://api.minimax.test",
    });

    expect(anthropic.id).toBe("anthropic");
    expect(openai.id).toBe("openai");
    expect(google.id).toBe("google");
    expect(minimax.id).toBe("minimax");

    await expect(anthropic.register(oauthConfig)).resolves.toHaveProperty("type");
    await expect(openai.register(oauthConfig)).resolves.toHaveProperty("type");
    await expect(google.register(oauthConfig)).resolves.toMatchObject({ type: "authorization_code" });
  });
});
