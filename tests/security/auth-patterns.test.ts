import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AuthError } from "../../src/errors";
import { err, ok } from "../../src/result";
import { ProviderAuthService } from "../../src/providers/auth-service";
import { EncryptedCredentialStore } from "../../src/providers/credentials/store";
import { CredentialBackedOAuthTokenStore } from "../../src/providers/oauth/token-store";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ApiKeyAuthStrategy, OAuthStrategy, OAuthTokens } from "../../src/providers/oauth/types";
import { authMiddleware } from "../../../reins-gateway/src/middleware/auth";

const workspaceRoot = join(import.meta.dir, "..", "..", "..");

async function readWorkspaceFile(relativePath: string): Promise<string> {
  return readFile(join(workspaceRoot, relativePath), "utf8");
}

async function createAuthService(overrides?: {
  apiKeyStrategies?: Record<string, ApiKeyAuthStrategy>;
  oauthStrategies?: Record<string, OAuthStrategy>;
}) {
  const tempDirectory = await mkdtemp(join(tmpdir(), "reins-security-auth-"));
  const store = new EncryptedCredentialStore({
    encryptionSecret: "security-auth-patterns-secret",
    filePath: join(tempDirectory, "credentials.enc.json"),
  });
  const registry = new ProviderRegistry();
  const service = new ProviderAuthService({
    store,
    registry,
    apiKeyStrategies: overrides?.apiKeyStrategies,
    oauthStrategies: overrides?.oauthStrategies,
  });

  return {
    service,
    cleanup: async () => rm(tempDirectory, { recursive: true, force: true }),
  };
}

describe("security/auth-patterns", () => {
  it("rejects missing auth token in gateway middleware", async () => {
    const response = await authMiddleware(
      {
        request: new Request("http://localhost/v1/chat/completions", {
          method: "POST",
        }),
        params: {},
        startTime: Date.now(),
      },
      async () => new Response("ok", { status: 200 }),
    );

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: string; authHint?: { mode?: string; tokenPrefix?: string } };
    expect(body.error).toBe("authentication_required");
    expect(body.authHint?.mode).toBe("machine-token");
    expect(body.authHint?.tokenPrefix).toBe("rm_");
  });

  it("contains explicit expired-session handling in backend auth validators", async () => {
    const validatorsSource = await readWorkspaceFile("reins-backend/convex/lib/validators.ts");

    expect(validatorsSource.includes("Session has expired")).toBe(true);
    expect(validatorsSource.includes("session.expiresAt <= Date.now()")).toBe(true);
    expect(validatorsSource.includes("session.isActive")).toBe(true);
  });

  it("contains user/session ownership checks for invalid user ids", async () => {
    const httpSource = await readWorkspaceFile("reins-backend/convex/http.ts");

    expect(httpSource.includes("Session does not belong to current user")).toBe(true);
    expect(httpSource.includes("validated.session.userId !== user._id")).toBe(true);
  });

  it("enforces plugin permission checks before data and capability access", async () => {
    const enforcementSource = await readWorkspaceFile("reins-core/src/plugins/enforcement.ts");

    expect(enforcementSource.includes("enforcePermission(this.checker, \"read_notes\", \"notes.list\")")).toBe(
      true,
    );
    expect(enforcementSource.includes("enforcePermission(this.checker, \"network_access\", action)")).toBe(true);
    expect(enforcementSource.includes("enforcePermission(this.checker, \"file_access\", action)")).toBe(true);
  });

  it("routes API key operations through provider auth strategies", async () => {
    const calls = {
      validate: 0,
      store: 0,
    };

    const strategy: ApiKeyAuthStrategy = {
      mode: "api_key",
      validate(input) {
        calls.validate += 1;
        return ok(input.key.trim());
      },
      async store() {
        calls.store += 1;
        return ok(undefined);
      },
      async retrieve() {
        return ok(null);
      },
      async revoke() {
        return ok(undefined);
      },
    };

    const fixture = await createAuthService({
      apiKeyStrategies: {
        anthropic: strategy,
      },
    });

    try {
      const result = await fixture.service.setApiKey("anthropic", " sk-test-strategy ");
      expect(result.ok).toBe(true);
      expect(calls.validate).toBe(1);
      expect(calls.store).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("routes OAuth token persistence through provider auth strategies", async () => {
    const calls = {
      storeTokens: 0,
    };

    const strategy: OAuthStrategy = {
      mode: "oauth",
      async initiate() {
        return err(new AuthError("not-used"));
      },
      async handleCallback() {
        return err(new AuthError("not-used"));
      },
      async refresh() {
        return err(new AuthError("not-used"));
      },
      async storeTokens() {
        calls.storeTokens += 1;
        return ok(undefined);
      },
      async retrieveTokens() {
        return ok(null);
      },
      async revoke() {
        return ok(undefined);
      },
    };

    const fixture = await createAuthService({
      oauthStrategies: {
        anthropic: strategy,
      },
    });

    try {
      const result = await fixture.service.setOAuthTokens("anthropic", {
        accessToken: "oauth-access-token",
        refreshToken: "oauth-refresh-token",
        expiresAt: new Date(Date.now() + 60_000),
        scope: "chat:write",
        tokenType: "Bearer",
      });

      expect(result.ok).toBe(true);
      expect(calls.storeTokens).toBe(1);
    } finally {
      await fixture.cleanup();
    }
  });

  it("returns actionable auth guidance from daemon/core command boundaries", async () => {
    const fixture = await createAuthService();

    try {
      const result = await fixture.service.handleCommand({
        action: "get",
        provider: "anthropic",
        source: "tui",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value.guidance?.action).toBe("configure");
      expect(result.value.guidance?.message).toContain("requires authentication");
      expect(result.value.guidance?.supportedModes).toEqual(["api_key", "oauth"]);
    } finally {
      await fixture.cleanup();
    }
  });

  it("persists OAuth credentials without plaintext leakage", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "reins-security-oauth-"));
    const filePath = join(tempDirectory, "credentials.enc.json");

    const store = new EncryptedCredentialStore({
      encryptionSecret: "security-auth-patterns-secret",
      filePath,
    });
    const tokenStore = new CredentialBackedOAuthTokenStore(store);

    const tokens: OAuthTokens = {
      accessToken: "oauth-access-sensitive-value",
      refreshToken: "oauth-refresh-sensitive-value",
      expiresAt: new Date(Date.now() + 60_000),
      tokenType: "Bearer",
      scope: "default",
    };

    try {
      await tokenStore.save("anthropic", tokens);
      const rawFile = await readFile(filePath, "utf8");

      expect(rawFile.includes(tokens.accessToken)).toBe(false);
      expect(rawFile.includes(tokens.refreshToken)).toBe(false);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("rotates OAuth tokens safely without leaving stale plaintext traces", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "reins-security-oauth-rotate-"));
    const filePath = join(tempDirectory, "credentials.enc.json");

    const store = new EncryptedCredentialStore({
      encryptionSecret: "security-auth-patterns-secret",
      filePath,
    });
    const tokenStore = new CredentialBackedOAuthTokenStore(store);

    const initialTokens: OAuthTokens = {
      accessToken: "oauth-initial-access",
      refreshToken: "oauth-initial-refresh",
      expiresAt: new Date(Date.now() + 60_000),
      tokenType: "Bearer",
      scope: "default",
    };

    const rotatedTokens: OAuthTokens = {
      accessToken: "oauth-rotated-access",
      refreshToken: "oauth-rotated-refresh",
      expiresAt: new Date(Date.now() + 120_000),
      tokenType: "Bearer",
      scope: "default",
    };

    try {
      await tokenStore.save("anthropic", initialTokens);
      const updateResult = await tokenStore.updateTokens("anthropic", rotatedTokens);
      expect(updateResult.ok).toBe(true);

      const loaded = await tokenStore.load("anthropic");
      expect(loaded).not.toBeNull();
      if (!loaded) {
        return;
      }

      expect(loaded.accessToken).toBe(rotatedTokens.accessToken);
      expect(loaded.refreshToken).toBe(rotatedTokens.refreshToken);

      const rawFile = await readFile(filePath, "utf8");
      expect(rawFile.includes(initialTokens.accessToken)).toBe(false);
      expect(rawFile.includes(initialTokens.refreshToken)).toBe(false);
      expect(rawFile.includes(rotatedTokens.accessToken)).toBe(false);
      expect(rawFile.includes(rotatedTokens.refreshToken)).toBe(false);
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });
});
