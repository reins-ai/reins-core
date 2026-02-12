import { describe, expect, it } from "bun:test";

import { KeyEncryption } from "../../../src/providers/byok/crypto";

describe("KeyEncryption", () => {
  it("encrypts and decrypts API keys", async () => {
    const encryption = new KeyEncryption("master-secret");
    const apiKey = "sk-test-very-secret-key";

    const encrypted = await encryption.encrypt(apiKey);
    const decrypted = await encryption.decrypt(encrypted.ciphertext, encrypted.iv);

    expect(decrypted).toBe(apiKey);
    expect(encrypted.ciphertext).not.toContain(apiKey);
  });

  it("uses a different IV per encryption", async () => {
    const encryption = new KeyEncryption("master-secret");
    const apiKey = "sk-repeat-value";

    const first = await encryption.encrypt(apiKey);
    const second = await encryption.encrypt(apiKey);

    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it("fails decryption with the wrong master key", async () => {
    const correct = new KeyEncryption("master-secret");
    const wrong = new KeyEncryption("wrong-master-secret");
    const encrypted = await correct.encrypt("sk-secret");

    await expect(wrong.decrypt(encrypted.ciphertext, encrypted.iv)).rejects.toThrow();
  });
});
