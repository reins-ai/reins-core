import { describe, expect, it } from "bun:test";

import { InMemoryKeyStorage } from "../../../src/providers/byok/storage";
import type { StoredKey } from "../../../src/providers/byok/types";

function makeStoredKey(overrides: Partial<StoredKey> = {}): StoredKey {
  return {
    id: "byok_test",
    provider: "openai",
    label: "Primary OpenAI Key",
    encryptedKey: "encrypted-value",
    iv: "iv-value",
    maskedKey: "sk-...abcd",
    createdAt: new Date("2026-02-09T00:00:00.000Z"),
    usageCount: 0,
    isValid: true,
    ...overrides,
  };
}

describe("InMemoryKeyStorage", () => {
  it("saves, gets, and deletes keys", async () => {
    const storage = new InMemoryKeyStorage();
    const key = makeStoredKey();

    await storage.save(key);
    expect(await storage.get(key.id)).toEqual(key);

    expect(await storage.delete(key.id)).toBe(true);
    expect(await storage.get(key.id)).toBeNull();
    expect(await storage.delete(key.id)).toBe(false);
  });

  it("sanitizes encrypted fields in list", async () => {
    const storage = new InMemoryKeyStorage();
    const key = makeStoredKey();

    await storage.save(key);
    const listed = await storage.list();

    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(key.id);
    expect(listed[0]?.encryptedKey).toBe("");
    expect(listed[0]?.iv).toBe("");

    const fetched = await storage.get(key.id);
    expect(fetched?.encryptedKey).toBe("encrypted-value");
    expect(fetched?.iv).toBe("iv-value");
  });

  it("updates usage metadata", async () => {
    const storage = new InMemoryKeyStorage();
    const key = makeStoredKey({ usageCount: 2, lastUsedAt: undefined });

    await storage.save(key);
    await storage.updateUsage(key.id);

    const updated = await storage.get(key.id);
    expect(updated?.usageCount).toBe(3);
    expect(updated?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("updates validation state", async () => {
    const storage = new InMemoryKeyStorage();
    const key = makeStoredKey({ isValid: false });

    await storage.save(key);
    await storage.updateValidation(key.id, true);

    const updated = await storage.get(key.id);
    expect(updated?.isValid).toBe(true);
  });
});
