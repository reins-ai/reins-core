import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../../src/errors";
import { KeyEncryption } from "../../../src/providers/byok/crypto";
import { BYOKManager } from "../../../src/providers/byok/manager";
import { InMemoryKeyStorage } from "../../../src/providers/byok/storage";

describe("BYOKManager", () => {
  it("adds key with encrypted payload and masked output", async () => {
    const storage = new InMemoryKeyStorage();
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage,
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    const stored = await manager.addKey({
      provider: "openai",
      apiKey: "sk-abc123xyz",
      label: "Main OpenAI",
    });

    expect(stored.label).toBe("Main OpenAI");
    expect(stored.maskedKey).toBe("sk-...3xyz");
    expect(stored.encryptedKey).not.toContain("sk-abc123xyz");
    expect(stored.iv.length).toBeGreaterThan(0);
    expect(stored.isValid).toBe(true);
  });

  it("lists keys without exposing encrypted data", async () => {
    const storage = new InMemoryKeyStorage();
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage,
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    await manager.addKey({ provider: "openai", apiKey: "sk-list-key" });

    const listed = await manager.listKeys();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.encryptedKey).toBe("");
    expect(listed[0]?.iv).toBe("");
    expect(listed[0]?.maskedKey).toBe("sk-...-key");
  });

  it("decrypts stored key by id", async () => {
    const storage = new InMemoryKeyStorage();
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage,
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    const stored = await manager.addKey({ provider: "openai", apiKey: "sk-super-secret" });
    await expect(manager.getDecryptedKey(stored.id)).resolves.toBe("sk-super-secret");
  });

  it("removes keys", async () => {
    const storage = new InMemoryKeyStorage();
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage,
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    const stored = await manager.addKey({ provider: "openai", apiKey: "sk-remove-test" });

    expect(await manager.removeKey(stored.id)).toBe(true);
    expect(await manager.removeKey(stored.id)).toBe(false);
  });

  it("tracks per-key usage", async () => {
    const storage = new InMemoryKeyStorage();
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage,
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    const stored = await manager.addKey({ provider: "openai", apiKey: "sk-usage-test" });

    await manager.trackUsage(stored.id);
    await manager.trackUsage(stored.id);

    const updated = await storage.get(stored.id);
    expect(updated?.usageCount).toBe(2);
    expect(updated?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("tests key validity and updates validation state", async () => {
    const storage = new InMemoryKeyStorage();
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage,
      fetchFn: async () => new Response(null, { status: 401 }),
    });

    const stored = await manager.addKey({ provider: "openai", apiKey: "sk-validation-test" });
    expect(stored.isValid).toBe(false);

    const isValid = await manager.testKey(stored.id);
    expect(isValid).toBe(false);

    const updated = await storage.get(stored.id);
    expect(updated?.isValid).toBe(false);
  });

  it("throws when decrypting unknown key", async () => {
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage: new InMemoryKeyStorage(),
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    await expect(manager.getDecryptedKey("missing")).rejects.toThrow(ProviderError);
  });

  it("masks API keys with prefix and last four chars", () => {
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage: new InMemoryKeyStorage(),
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    expect(manager.maskApiKey("sk-abc123xyz")).toBe("sk-...3xyz");
  });
});
