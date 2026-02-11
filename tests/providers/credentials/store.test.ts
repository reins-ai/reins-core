import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";

import { EncryptedCredentialStore } from "../../../src/providers/credentials/store";

async function makeTempDirectory(prefix: string): Promise<string> {
  const directory = `${prefix}${crypto.randomUUID()}`;
  await mkdir(directory, { recursive: true });
  return directory;
}

describe("EncryptedCredentialStore", () => {
  it("stores encrypted credentials and reads decrypted payload", async () => {
    const directory = await makeTempDirectory("/tmp/reins-credentials-");
    const store = new EncryptedCredentialStore({
      encryptionSecret: "credential-secret",
      filePath: `${directory}/credentials.enc.json`,
    });

    const setResult = await store.set({
      id: "cred_openai",
      provider: "openai",
      type: "api_key",
      accountId: "default",
      metadata: { label: "Main OpenAI" },
      payload: {
        encryptedKey: "ciphertext-value",
        iv: "payload-iv",
        maskedKey: "sk-...1234",
        usageCount: 0,
        isValid: true,
      },
    });

    expect(setResult.ok).toBe(true);
    if (!setResult.ok) {
      return;
    }

    const getResult = await store.get({ id: "cred_openai", type: "api_key" });
    expect(getResult.ok).toBe(true);
    if (!getResult.ok || !getResult.value) {
      return;
    }

    const payloadResult = await store.decryptPayload<Record<string, unknown>>(getResult.value);
    expect(payloadResult.ok).toBe(true);
    if (!payloadResult.ok) {
      return;
    }

    expect(payloadResult.value.maskedKey).toBe("sk-...1234");

    const rawText = await Bun.file(store.getFilePath()).text();
    expect(rawText.includes("ciphertext-value")).toBe(false);
    expect(rawText.includes("sk-...1234")).toBe(false);
  });

  it("supports list and revoke without plaintext leakage", async () => {
    const directory = await makeTempDirectory("/tmp/reins-credentials-");
    const store = new EncryptedCredentialStore({
      encryptionSecret: "credential-secret",
      filePath: `${directory}/credentials.enc.json`,
    });

    const first = await store.set({
      id: "oauth_openai",
      provider: "openai",
      type: "oauth",
      accountId: "openai",
      payload: {
        accessToken: "openai-access-token",
        refreshToken: "openai-refresh-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        scope: "chat:read",
        tokenType: "Bearer",
      },
    });

    const second = await store.set({
      id: "api_anthropic",
      provider: "anthropic",
      type: "api_key",
      payload: {
        encryptedKey: "ciphertext-2",
        iv: "iv-2",
        maskedKey: "sk-...abcd",
        usageCount: 3,
        isValid: true,
      },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);

    const all = await store.list();
    expect(all.ok).toBe(true);
    if (!all.ok) {
      return;
    }

    expect(all.value).toHaveLength(2);

    const revoke = await store.revoke("oauth_openai");
    expect(revoke.ok).toBe(true);
    expect(revoke.ok && revoke.value).toBe(true);

    const active = await store.list();
    expect(active.ok).toBe(true);
    if (!active.ok) {
      return;
    }

    expect(active.value).toHaveLength(1);
    expect(active.value[0]?.id).toBe("api_anthropic");

    const includingRevoked = await store.list({ includeRevoked: true });
    expect(includingRevoked.ok).toBe(true);
    if (!includingRevoked.ok) {
      return;
    }

    expect(includingRevoked.value).toHaveLength(2);
    const revoked = includingRevoked.value.find((record) => record.id === "oauth_openai");
    expect(revoked?.revokedAt).toBeTypeOf("number");
  });

  it("updates sync envelope metadata after writes", async () => {
    const directory = await makeTempDirectory("/tmp/reins-credentials-");
    const store = new EncryptedCredentialStore({
      encryptionSecret: "credential-secret",
      filePath: `${directory}/credentials.enc.json`,
    });

    const beforeEnvelope = await store.getEnvelope();
    expect(beforeEnvelope.ok).toBe(true);
    if (!beforeEnvelope.ok) {
      return;
    }

    const writeResult = await store.set({
      id: "token_google",
      provider: "google",
      type: "token",
      payload: {
        token: "token-value",
      },
    });
    expect(writeResult.ok).toBe(true);

    const afterEnvelope = await store.getEnvelope();
    expect(afterEnvelope.ok).toBe(true);
    if (!afterEnvelope.ok) {
      return;
    }

    expect(afterEnvelope.value.version).toBe(1);
    expect(afterEnvelope.value.checksum.length).toBeGreaterThan(0);
    expect(afterEnvelope.value.updatedAt).toBeGreaterThanOrEqual(beforeEnvelope.value.updatedAt);
  });
});
