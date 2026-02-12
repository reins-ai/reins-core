import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";

import { EncryptedCredentialStore } from "../../src/providers/credentials/store";
import { CredentialBackedOAuthTokenStore } from "../../src/providers/oauth/token-store";
import type { OAuthTokens } from "../../src/providers/oauth/types";
import { ToolExecutor } from "../../src/tools/executor";
import { ToolRegistry } from "../../src/tools/registry";

function createEchoExecutor(): ToolExecutor {
  const registry = new ToolRegistry();

  registry.register({
    definition: {
      name: "echo-input",
      description: "Echoes payload",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string" },
        },
        required: ["content"],
      },
    },
    async execute(args) {
      return {
        callId: "tool-call",
        name: "echo-input",
        result: {
          content: String(args.content ?? ""),
        },
      };
    },
  });

  return new ToolExecutor(registry);
}

describe("security/input-validation", () => {
  it("treats XSS payloads as inert string data", async () => {
    const executor = createEchoExecutor();
    const payload = '<script>alert("xss")</script>';

    const result = await executor.execute(
      {
        id: "xss",
        name: "echo-input",
        arguments: { content: payload },
      },
      { conversationId: "conv-security", userId: "user-security" },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ content: payload });
  });

  it("treats SQL injection payloads as inert string data", async () => {
    const executor = createEchoExecutor();
    const payload = "' OR 1=1; DROP TABLE users; --";

    const result = await executor.execute(
      {
        id: "sql",
        name: "echo-input",
        arguments: { content: payload },
      },
      { conversationId: "conv-security", userId: "user-security" },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ content: payload });
  });

  it("handles oversized inputs without crashing", async () => {
    const executor = createEchoExecutor();
    const payload = "A".repeat(200_000);

    const result = await executor.executeWithTimeout(
      {
        id: "oversized",
        name: "echo-input",
        arguments: { content: payload },
      },
      { conversationId: "conv-security", userId: "user-security" },
      250,
    );

    expect(result.error).toBeUndefined();
    expect((result.result as { content: string }).content.length).toBe(200_000);
  });

  it("preserves unicode and emoji payloads", async () => {
    const executor = createEchoExecutor();
    const payload = "Hello 👋🏽 — こんにちは — مرحبا — cafe\u0301";

    const result = await executor.execute(
      {
        id: "unicode",
        name: "echo-input",
        arguments: { content: payload },
      },
      { conversationId: "conv-security", userId: "user-security" },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ content: payload });
  });

  it("preserves null bytes as inert data", async () => {
    const executor = createEchoExecutor();
    const payload = "abc\u0000def";

    const result = await executor.execute(
      {
        id: "null-byte",
        name: "echo-input",
        arguments: { content: payload },
      },
      { conversationId: "conv-security", userId: "user-security" },
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ content: payload });
  });
});

async function makeTempDirectory(prefix: string): Promise<string> {
  const directory = `${prefix}${crypto.randomUUID()}`;
  await mkdir(directory, { recursive: true });
  return directory;
}

function createTestStore(directory: string): EncryptedCredentialStore {
  return new EncryptedCredentialStore({
    encryptionSecret: "test-encryption-secret-for-security-tests",
    filePath: `${directory}/credentials.enc.json`,
  });
}

describe("security/credential-storage", () => {
  it("encrypts API key credentials at rest with no plaintext leakage", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const store = createTestStore(directory);

    const apiKey = "sk-ant-api03-real-secret-key-value-1234567890";
    const setResult = await store.set({
      id: "cred_anthropic_key",
      provider: "anthropic",
      type: "api_key",
      accountId: "default",
      metadata: { label: "Anthropic Production" },
      payload: {
        encryptedKey: apiKey,
        iv: "test-iv-value",
        maskedKey: "sk-ant-...7890",
        usageCount: 0,
        isValid: true,
      },
    });

    expect(setResult.ok).toBe(true);

    const rawFile = await Bun.file(store.getFilePath()).text();
    expect(rawFile.includes(apiKey)).toBe(false);
    expect(rawFile.includes("real-secret-key-value")).toBe(false);
    expect(rawFile.includes("Anthropic Production")).toBe(false);
    expect(rawFile.includes("test-iv-value")).toBe(false);
  });

  it("encrypts OAuth tokens at rest with no plaintext leakage", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const store = createTestStore(directory);

    const accessToken = "oauth-access-token-secret-value-xyz";
    const refreshToken = "oauth-refresh-token-secret-value-abc";
    const setResult = await store.set({
      id: "oauth_anthropic",
      provider: "anthropic",
      type: "oauth",
      accountId: "anthropic",
      payload: {
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        scope: "default",
        tokenType: "Bearer",
      },
    });

    expect(setResult.ok).toBe(true);

    const rawFile = await Bun.file(store.getFilePath()).text();
    expect(rawFile.includes(accessToken)).toBe(false);
    expect(rawFile.includes(refreshToken)).toBe(false);
    expect(rawFile.includes("Bearer")).toBe(false);
  });

  it("persists API key credentials across store instances", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const filePath = `${directory}/credentials.enc.json`;
    const secret = "cross-session-secret";

    const store1 = new EncryptedCredentialStore({ encryptionSecret: secret, filePath });
    const setResult = await store1.set({
      id: "cred_anthropic_persist",
      provider: "anthropic",
      type: "api_key",
      payload: {
        encryptedKey: "persisted-key-value",
        iv: "persist-iv",
        maskedKey: "sk-...persist",
        usageCount: 5,
        isValid: true,
      },
    });
    expect(setResult.ok).toBe(true);

    const store2 = new EncryptedCredentialStore({ encryptionSecret: secret, filePath });
    const getResult = await store2.get({ id: "cred_anthropic_persist", type: "api_key" });
    expect(getResult.ok).toBe(true);
    if (!getResult.ok || !getResult.value) {
      return;
    }

    expect(getResult.value.provider).toBe("anthropic");
    expect(getResult.value.type).toBe("api_key");

    const decrypted = await store2.decryptPayload<Record<string, unknown>>(getResult.value);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) {
      return;
    }

    expect(decrypted.value.encryptedKey).toBe("persisted-key-value");
    expect(decrypted.value.maskedKey).toBe("sk-...persist");
    expect(decrypted.value.usageCount).toBe(5);
  });

  it("persists OAuth tokens across store instances", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const filePath = `${directory}/credentials.enc.json`;
    const secret = "cross-session-oauth-secret";

    const store1 = new EncryptedCredentialStore({ encryptionSecret: secret, filePath });
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const setResult = await store1.set({
      id: "oauth_anthropic_persist",
      provider: "anthropic",
      type: "oauth",
      accountId: "anthropic",
      payload: {
        accessToken: "persist-access-token",
        refreshToken: "persist-refresh-token",
        expiresAt,
        scope: "default",
        tokenType: "Bearer",
      },
    });
    expect(setResult.ok).toBe(true);

    const store2 = new EncryptedCredentialStore({ encryptionSecret: secret, filePath });
    const getResult = await store2.get({ id: "oauth_anthropic_persist", type: "oauth" });
    expect(getResult.ok).toBe(true);
    if (!getResult.ok || !getResult.value) {
      return;
    }

    expect(getResult.value.provider).toBe("anthropic");
    expect(getResult.value.type).toBe("oauth");

    const decrypted = await store2.decryptPayload<Record<string, unknown>>(getResult.value);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) {
      return;
    }

    expect(decrypted.value.accessToken).toBe("persist-access-token");
    expect(decrypted.value.refreshToken).toBe("persist-refresh-token");
    expect(decrypted.value.expiresAt).toBe(expiresAt);
  });

  it("safely rotates credentials via update without losing creation metadata", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const store = createTestStore(directory);

    const setResult = await store.set({
      id: "cred_rotate_test",
      provider: "anthropic",
      type: "api_key",
      payload: { encryptedKey: "original-key", iv: "iv-1", maskedKey: "sk-...orig", usageCount: 10, isValid: true },
    });
    expect(setResult.ok).toBe(true);
    if (!setResult.ok) {
      return;
    }

    const originalCreatedAt = setResult.value.createdAt;

    const updateResult = await store.update({
      id: "cred_rotate_test",
      payload: { encryptedKey: "rotated-key", iv: "iv-2", maskedKey: "sk-...rotd", usageCount: 0, isValid: true },
    });
    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) {
      return;
    }

    expect(updateResult.value.createdAt).toBe(originalCreatedAt);
    expect(updateResult.value.updatedAt).toBeGreaterThanOrEqual(originalCreatedAt);

    const decrypted = await store.decryptPayload<Record<string, unknown>>(updateResult.value);
    expect(decrypted.ok).toBe(true);
    if (!decrypted.ok) {
      return;
    }

    expect(decrypted.value.encryptedKey).toBe("rotated-key");

    const rawFile = await Bun.file(store.getFilePath()).text();
    expect(rawFile.includes("original-key")).toBe(false);
    expect(rawFile.includes("rotated-key")).toBe(false);
  });

  it("rejects update on revoked credentials", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const store = createTestStore(directory);

    await store.set({
      id: "cred_revoked_update",
      provider: "anthropic",
      type: "api_key",
      payload: { encryptedKey: "key", iv: "iv", maskedKey: "sk-...x", usageCount: 0, isValid: true },
    });

    const revokeResult = await store.revoke("cred_revoked_update");
    expect(revokeResult.ok).toBe(true);

    const updateResult = await store.update({
      id: "cred_revoked_update",
      payload: { encryptedKey: "new-key", iv: "iv-2", maskedKey: "sk-...y", usageCount: 0, isValid: true },
    });

    expect(updateResult.ok).toBe(false);
    if (!updateResult.ok) {
      expect(updateResult.error.message).toContain("revoked");
    }
  });

  it("rejects update on non-existent credentials", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const store = createTestStore(directory);

    const updateResult = await store.update({
      id: "cred_nonexistent",
      payload: { key: "value" },
    });

    expect(updateResult.ok).toBe(false);
    if (!updateResult.ok) {
      expect(updateResult.error.message).toContain("not found");
    }
  });

  it("safely rotates OAuth tokens via CredentialBackedOAuthTokenStore", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const credStore = createTestStore(directory);
    const tokenStore = new CredentialBackedOAuthTokenStore(credStore);

    const originalTokens: OAuthTokens = {
      accessToken: "original-access-token",
      refreshToken: "original-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: "default",
      tokenType: "Bearer",
    };

    await tokenStore.save("anthropic", originalTokens);

    const rotatedTokens: OAuthTokens = {
      accessToken: "rotated-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: new Date(Date.now() + 7_200_000),
      scope: "default",
      tokenType: "Bearer",
    };

    const updateResult = await tokenStore.updateTokens("anthropic", rotatedTokens);
    expect(updateResult.ok).toBe(true);

    const loaded = await tokenStore.load("anthropic");
    expect(loaded).not.toBeNull();
    if (!loaded) {
      return;
    }

    expect(loaded.accessToken).toBe("rotated-access-token");
    expect(loaded.refreshToken).toBe("rotated-refresh-token");

    const rawFile = await Bun.file(credStore.getFilePath()).text();
    expect(rawFile.includes("original-access-token")).toBe(false);
    expect(rawFile.includes("rotated-access-token")).toBe(false);
    expect(rawFile.includes("original-refresh-token")).toBe(false);
    expect(rawFile.includes("rotated-refresh-token")).toBe(false);
  });

  it("creates new credential when rotating tokens for a provider without existing tokens", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const credStore = createTestStore(directory);
    const tokenStore = new CredentialBackedOAuthTokenStore(credStore);

    const tokens: OAuthTokens = {
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: "default",
      tokenType: "Bearer",
    };

    const updateResult = await tokenStore.updateTokens("anthropic", tokens);
    expect(updateResult.ok).toBe(true);

    const loaded = await tokenStore.load("anthropic");
    expect(loaded).not.toBeNull();
    if (!loaded) {
      return;
    }

    expect(loaded.accessToken).toBe("fresh-access-token");
  });

  it("fails decryption with wrong encryption secret", async () => {
    const directory = await makeTempDirectory("/tmp/reins-cred-security-");
    const filePath = `${directory}/credentials.enc.json`;

    const store1 = new EncryptedCredentialStore({ encryptionSecret: "correct-secret", filePath });
    await store1.set({
      id: "cred_wrong_secret",
      provider: "anthropic",
      type: "api_key",
      payload: { key: "secret-value" },
    });

    const store2 = new EncryptedCredentialStore({ encryptionSecret: "wrong-secret", filePath });
    const loadResult = await store2.get({ id: "cred_wrong_secret" });

    expect(loadResult.ok).toBe(false);
  });
});
