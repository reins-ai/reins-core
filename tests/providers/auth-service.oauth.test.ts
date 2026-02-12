import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthError } from "../../src/errors";
import { err, ok } from "../../src/result";
import { ProviderAuthService } from "../../src/providers/auth-service";
import { EncryptedCredentialStore } from "../../src/providers/credentials/store";
import { ProviderRegistry } from "../../src/providers/registry";
import type { OAuthStrategy, OAuthTokens } from "../../src/providers/oauth/types";

function makeTokens(overrides: Partial<OAuthTokens> = {}): OAuthTokens {
  return {
    accessToken: "oauth-access",
    refreshToken: "oauth-refresh",
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    scope: "messages:read messages:write",
    tokenType: "Bearer",
    ...overrides,
  };
}

async function createFixture(strategy: OAuthStrategy) {
  const tempDirectory = await mkdtemp(join(tmpdir(), "reins-auth-oauth-service-"));
  const store = new EncryptedCredentialStore({
    encryptionSecret: "auth-oauth-service-secret",
    filePath: join(tempDirectory, "credentials.enc.json"),
  });
  const service = new ProviderAuthService({
    store,
    registry: new ProviderRegistry(),
    oauthStrategies: {
      anthropic: strategy,
    },
  });

  return {
    service,
    store,
    cleanup: async () => rm(tempDirectory, { recursive: true, force: true }),
  };
}

describe("ProviderAuthService OAuth orchestration", () => {
  it("initiates OAuth flow through provider strategy", async () => {
    const strategy: OAuthStrategy = {
      mode: "oauth",
      async initiate() {
        return ok({
          type: "authorization_code",
          authorizationUrl: "https://auth.example.com/authorize?state=test-state",
          state: "test-state",
          codeVerifier: "test-verifier",
        });
      },
      async handleCallback() {
        return err(new AuthError("not-used"));
      },
      async refresh() {
        return err(new AuthError("not-used"));
      },
      async storeTokens() {
        return ok(undefined);
      },
      async retrieveTokens() {
        return ok(null);
      },
      async revoke() {
        return ok(undefined);
      },
    };

    const fixture = await createFixture(strategy);

    try {
      const result = await fixture.service.initiateOAuth("anthropic");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.type).toBe("authorization_code");
      expect(result.value.state).toBe("test-state");
    } finally {
      await fixture.cleanup();
    }
  });

  it("completes callback and persists exchanged tokens", async () => {
    const callbackTokens = makeTokens();
    let persistedTokens: OAuthTokens | null = null;
    const strategy: OAuthStrategy = {
      mode: "oauth",
      async initiate() {
        return err(new AuthError("not-used"));
      },
      async handleCallback() {
        return ok(callbackTokens);
      },
      async refresh() {
        return err(new AuthError("not-used"));
      },
      async storeTokens(context) {
        persistedTokens = context.tokens;
        return ok(undefined);
      },
      async retrieveTokens() {
        return ok(null);
      },
      async revoke() {
        return ok(undefined);
      },
    };

    const fixture = await createFixture(strategy);

    try {
      const result = await fixture.service.completeOAuthCallback("anthropic", {
        code: "auth-code",
        state: "state-123",
      });
      expect(result.ok).toBe(true);
      expect(persistedTokens?.accessToken).toBe("oauth-access");
      expect(persistedTokens?.refreshToken).toBe("oauth-refresh");
    } finally {
      await fixture.cleanup();
    }
  });

  it("refreshes expired OAuth tokens before returning access token", async () => {
    let storedTokens = makeTokens({ expiresAt: new Date(Date.now() + 60 * 1000) });
    const refreshedTokens = makeTokens({
      accessToken: "oauth-access-refreshed",
      refreshToken: "oauth-refresh-refreshed",
      expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000),
    });

    const strategy: OAuthStrategy = {
      mode: "oauth",
      async initiate() {
        return err(new AuthError("not-used"));
      },
      async handleCallback() {
        return err(new AuthError("not-used"));
      },
      async refresh() {
        return ok(refreshedTokens);
      },
      async storeTokens(context) {
        storedTokens = context.tokens;
        return ok(undefined);
      },
      async retrieveTokens() {
        return ok(storedTokens);
      },
      async revoke() {
        return ok(undefined);
      },
    };

    const fixture = await createFixture(strategy);

    try {
      const result = await fixture.service.getOAuthAccessToken("anthropic");
      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value).toBe("oauth-access-refreshed");
      expect(storedTokens.accessToken).toBe("oauth-access-refreshed");
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns re-auth guidance when refresh fails", async () => {
    const strategy: OAuthStrategy = {
      mode: "oauth",
      async initiate() {
        return err(new AuthError("not-used"));
      },
      async handleCallback() {
        return err(new AuthError("not-used"));
      },
      async refresh() {
        return err(new AuthError("refresh endpoint rejected token"));
      },
      async storeTokens() {
        return ok(undefined);
      },
      async retrieveTokens() {
        return ok(makeTokens({ expiresAt: new Date(Date.now() + 30 * 1000) }));
      },
      async revoke() {
        return ok(undefined);
      },
    };

    const fixture = await createFixture(strategy);

    try {
      const result = await fixture.service.getOAuthAccessToken("anthropic");
      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.message).toContain("Re-authenticate");
    } finally {
      await fixture.cleanup();
    }
  });
});
