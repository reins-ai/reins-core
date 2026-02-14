import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProviderAuthService } from "../../src/providers/auth-service";
import { EncryptedCredentialStore } from "../../src/providers/credentials/store";
import { ProviderRegistry } from "../../src/providers/registry";

async function createAuthService() {
  const tempDirectory = await mkdtemp(join(tmpdir(), "reins-provider-auth-"));
  const store = new EncryptedCredentialStore({
    encryptionSecret: "provider-auth-secret",
    filePath: join(tempDirectory, "credentials.enc.json"),
  });
  const registry = new ProviderRegistry();
  const service = new ProviderAuthService({ store, registry });

  return {
    service,
    store,
    cleanup: async () => rm(tempDirectory, { recursive: true, force: true }),
  };
}

describe("integration/provider-auth-flow", () => {
  it("sets and retrieves API key credentials", async () => {
    const fixture = await createAuthService();

    try {
      const setResult = await fixture.service.setApiKey("openai", "sk-test-12345", { label: "Primary OpenAI" });
      expect(setResult.ok).toBe(true);

      const credentialResult = await fixture.service.getCredential("openai");
      expect(credentialResult.ok).toBe(true);
      if (!credentialResult.ok || !credentialResult.value) {
        return;
      }

      expect(credentialResult.value.type).toBe("api_key");
      expect(credentialResult.value.metadata).toEqual({ label: "Primary OpenAI" });

      const payloadResult = await fixture.store.decryptPayload<Record<string, string>>(credentialResult.value);
      expect(payloadResult.ok).toBe(true);
      if (!payloadResult.ok) {
        return;
      }

      expect(payloadResult.value.key).toBe("sk-test-12345");
    } finally {
      await fixture.cleanup();
    }
  });

  it("sets and retrieves OAuth credentials", async () => {
    const fixture = await createAuthService();

    try {
      const setResult = await fixture.service.setOAuthTokens("anthropic", {
        accessToken: "oauth-access-token",
        refreshToken: "oauth-refresh-token",
        expiresAt: new Date("2026-02-11T12:00:00.000Z"),
        scope: "chat:read chat:write",
        tokenType: "Bearer",
      });
      expect(setResult.ok).toBe(true);

      const credentialResult = await fixture.service.getCredential("anthropic");
      expect(credentialResult.ok).toBe(true);
      if (!credentialResult.ok || !credentialResult.value) {
        return;
      }

      expect(credentialResult.value.type).toBe("oauth");

      const payloadResult = await fixture.store.decryptPayload<Record<string, string>>(credentialResult.value);
      expect(payloadResult.ok).toBe(true);
      if (!payloadResult.ok) {
        return;
      }

      expect(payloadResult.value.accessToken).toBe("oauth-access-token");
      expect(payloadResult.value.refreshToken).toBe("oauth-refresh-token");
      expect(payloadResult.value.expiresAt).toBe("2026-02-11T12:00:00.000Z");
    } finally {
      await fixture.cleanup();
    }
  });

  it("lists providers with auth status and includes local no-auth providers", async () => {
    const fixture = await createAuthService();

    try {
      const apiResult = await fixture.service.setApiKey("openai", "sk-openai-1234");
      const oauthResult = await fixture.service.setOAuthTokens("google", {
        accessToken: "google-access",
        refreshToken: "google-refresh",
        expiresAt: new Date("2026-02-11T13:00:00.000Z"),
        scope: "profile",
        tokenType: "Bearer",
      });
      expect(apiResult.ok).toBe(true);
      expect(oauthResult.ok).toBe(true);

      const listResult = await fixture.service.listProviders();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) {
        return;
      }

      const openai = listResult.value.find((status) => status.provider === "openai");
      expect(openai).toBeDefined();
      expect(openai?.requiresAuth).toBe(true);
      expect(openai?.configured).toBe(true);
      expect(openai?.credentialType).toBe("api_key");

      const google = listResult.value.find((status) => status.provider === "google");
      expect(google).toBeDefined();
      expect(google?.configured).toBe(true);
      expect(google?.credentialType).toBe("oauth");

      const gateway = listResult.value.find((status) => status.provider === "reins-gateway");
      expect(gateway).toBeDefined();
      expect(gateway?.authModes).toEqual(["api_key"]);
      expect(gateway?.requiresAuth).toBe(true);

      const ollama = listResult.value.find((status) => status.provider === "ollama");
      const vllm = listResult.value.find((status) => status.provider === "vllm");
      const lmstudio = listResult.value.find((status) => status.provider === "lmstudio");

      expect(ollama).toEqual({
        provider: "ollama",
        requiresAuth: false,
        authModes: [],
        configured: true,
        connectionState: "ready",
        credentialType: undefined,
        updatedAt: undefined,
        envVars: undefined,
        baseUrl: "http://localhost:11434",
      });
      expect(vllm?.requiresAuth).toBe(false);
      expect(vllm?.authModes).toEqual([]);
      expect(vllm?.configured).toBe(true);
      expect(lmstudio?.requiresAuth).toBe(false);
      expect(lmstudio?.authModes).toEqual([]);
      expect(lmstudio?.configured).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("revokes provider credentials", async () => {
    const fixture = await createAuthService();

    try {
      const setResult = await fixture.service.setApiKey("openai", "sk-revoke-me");
      expect(setResult.ok).toBe(true);

      const revokeResult = await fixture.service.revokeProvider("openai");
      expect(revokeResult.ok).toBe(true);

      const credentialResult = await fixture.service.getCredential("openai");
      expect(credentialResult.ok).toBe(true);
      if (!credentialResult.ok) {
        return;
      }

      expect(credentialResult.value).toBeNull();
    } finally {
      await fixture.cleanup();
    }
  });

  it("validates Reins Gateway API key format", async () => {
    const fixture = await createAuthService();

    try {
      const invalidResult = await fixture.service.setApiKey("reins-gateway", "invalid-key");
      expect(invalidResult.ok).toBe(false);

      const validResult = await fixture.service.setApiKey("reins-gateway", "rk_live_abcd1234");
      expect(validResult.ok).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  });

  it("persists API key credentials for search providers", async () => {
    const fixture = await createAuthService();

    try {
      const braveResult = await fixture.service.setApiKey("brave_search", "brv-test-key");
      const exaResult = await fixture.service.setApiKey("exa", "exa-test-key");

      expect(braveResult.ok).toBe(true);
      expect(exaResult.ok).toBe(true);

      const braveCredential = await fixture.service.getCredential("brave_search");
      const exaCredential = await fixture.service.getCredential("exa");

      expect(braveCredential.ok).toBe(true);
      expect(exaCredential.ok).toBe(true);
      if (!braveCredential.ok || !braveCredential.value || !exaCredential.ok || !exaCredential.value) {
        return;
      }

      expect(braveCredential.value.type).toBe("api_key");
      expect(exaCredential.value.type).toBe("api_key");

      const bravePayload = await fixture.store.decryptPayload<Record<string, string>>(braveCredential.value);
      const exaPayload = await fixture.store.decryptPayload<Record<string, string>>(exaCredential.value);

      expect(bravePayload.ok).toBe(true);
      expect(exaPayload.ok).toBe(true);
      if (!bravePayload.ok || !exaPayload.ok) {
        return;
      }

      expect(bravePayload.value.key).toBe("brv-test-key");
      expect(exaPayload.value.key).toBe("exa-test-key");

      const providersResult = await fixture.service.listProviders();
      expect(providersResult.ok).toBe(true);
      if (!providersResult.ok) {
        return;
      }

      const listedProviderIds = providersResult.value.map((status) => status.provider);
      expect(listedProviderIds).not.toContain("brave_search");
      expect(listedProviderIds).not.toContain("exa");
    } finally {
      await fixture.cleanup();
    }
  });

  it("marks local providers as no-auth in auth helpers", async () => {
    const fixture = await createAuthService();

    try {
      expect(fixture.service.requiresAuth("ollama")).toBe(false);
      expect(fixture.service.requiresAuth("vllm")).toBe(false);
      expect(fixture.service.requiresAuth("lmstudio")).toBe(false);
      expect(fixture.service.getAuthMethods("ollama")).toEqual([]);
      expect(fixture.service.getAuthMethods("vllm")).toEqual([]);
      expect(fixture.service.getAuthMethods("lmstudio")).toEqual([]);
    } finally {
      await fixture.cleanup();
    }
  });
});
