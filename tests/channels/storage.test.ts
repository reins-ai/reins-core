import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";

import { ChannelError } from "../../src/channels/errors";
import { ChannelCredentialStorage, maskToken } from "../../src/channels/storage";
import { EncryptedCredentialStore } from "../../src/providers/credentials/store";

async function createStorage(secret = "test-encryption-secret"): Promise<ChannelCredentialStorage> {
  const directory = `/tmp/reins-channel-storage-${crypto.randomUUID()}`;
  await mkdir(directory, { recursive: true });

  const store = new EncryptedCredentialStore({
    encryptionSecret: secret,
    filePath: `${directory}/credentials.enc.json`,
  });

  return new ChannelCredentialStorage({ store });
}

describe("maskToken", () => {
  it("masks a standard-length token showing first 3 and last 6", () => {
    expect(maskToken("1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ")).toBe("123********************UvwxYZ");
  });

  it("masks a short token (7-9 chars) showing last 6 with asterisks", () => {
    expect(maskToken("123456789")).toBe("***456789");
    expect(maskToken("1234567")).toBe("*234567");
  });

  it("masks a very short token (≤ 6 chars) entirely", () => {
    expect(maskToken("abc")).toBe("***");
    expect(maskToken("abcdef")).toBe("******");
  });

  it("returns asterisks for empty token", () => {
    expect(maskToken("")).toBe("***");
    expect(maskToken("   ")).toBe("***");
  });

  it("trims whitespace before masking", () => {
    expect(maskToken("  1234567890abcdef  ")).toBe("123*******abcdef");
  });
});

describe("ChannelCredentialStorage", () => {
  it("saves and retrieves a telegram bot token", async () => {
    const storage = await createStorage();
    const token = "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ";

    const stored = await storage.saveToken("telegram", token);

    expect(stored.platform).toBe("telegram");
    expect(stored.maskedToken).toBe(maskToken(token));
    expect(stored.id).toBeDefined();
    expect(stored.createdAt).toBeGreaterThan(0);

    const retrieved = await storage.getToken("telegram");
    expect(retrieved).toBe(token);
  });

  it("saves and retrieves a discord bot token", async () => {
    const storage = await createStorage();
    const token = "MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GrWPLw.abc123def456ghi789";

    await storage.saveToken("discord", token);

    const retrieved = await storage.getToken("discord");
    expect(retrieved).toBe(token);
  });

  it("returns null for a platform with no stored token", async () => {
    const storage = await createStorage();

    const result = await storage.getToken("telegram");
    expect(result).toBeNull();
  });

  it("overwrites existing token when saving for the same platform", async () => {
    const storage = await createStorage();
    const firstToken = "first-token-value-abcdef";
    const secondToken = "second-token-value-xyz123";

    await storage.saveToken("telegram", firstToken);
    await storage.saveToken("telegram", secondToken);

    const retrieved = await storage.getToken("telegram");
    expect(retrieved).toBe(secondToken);

    const listed = await storage.listTokens();
    const telegramTokens = listed.filter((t) => t.platform === "telegram");
    expect(telegramTokens).toHaveLength(1);
  });

  it("deletes a stored token", async () => {
    const storage = await createStorage();
    await storage.saveToken("telegram", "token-to-delete-abcdef");

    const deleted = await storage.deleteToken("telegram");
    expect(deleted).toBe(true);

    const retrieved = await storage.getToken("telegram");
    expect(retrieved).toBeNull();
  });

  it("returns false when deleting a non-existent token", async () => {
    const storage = await createStorage();

    const deleted = await storage.deleteToken("discord");
    expect(deleted).toBe(false);
  });

  it("lists tokens with masked values for multiple platforms", async () => {
    const storage = await createStorage();
    const telegramToken = "1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ";
    const discordToken = "MTIzNDU2Nzg5MDEyMzQ1Njc4OQ.GrWPLw.abc123def456ghi789";

    await storage.saveToken("telegram", telegramToken);
    await storage.saveToken("discord", discordToken);

    const listed = await storage.listTokens();
    expect(listed).toHaveLength(2);

    const telegram = listed.find((t) => t.platform === "telegram");
    const discord = listed.find((t) => t.platform === "discord");

    expect(telegram).toBeDefined();
    expect(telegram!.maskedToken).toBe(maskToken(telegramToken));
    expect(telegram!.maskedToken).not.toBe(telegramToken);

    expect(discord).toBeDefined();
    expect(discord!.maskedToken).toBe(maskToken(discordToken));
    expect(discord!.maskedToken).not.toBe(discordToken);
  });

  it("returns empty list when no tokens are stored", async () => {
    const storage = await createStorage();

    const listed = await storage.listTokens();
    expect(listed).toHaveLength(0);
  });

  it("checks whether a token exists for a platform", async () => {
    const storage = await createStorage();

    expect(await storage.hasToken("telegram")).toBe(false);

    await storage.saveToken("telegram", "some-token-value-abcdef");
    expect(await storage.hasToken("telegram")).toBe(true);
    expect(await storage.hasToken("discord")).toBe(false);
  });

  it("isolates tokens between platforms", async () => {
    const storage = await createStorage();
    await storage.saveToken("telegram", "telegram-token-abcdef");
    await storage.saveToken("discord", "discord-token-xyz123");

    await storage.deleteToken("telegram");

    expect(await storage.getToken("telegram")).toBeNull();
    expect(await storage.getToken("discord")).toBe("discord-token-xyz123");
  });

  it("throws ChannelError for empty token", async () => {
    const storage = await createStorage();

    expect(storage.saveToken("telegram", "")).rejects.toThrow(ChannelError);
    expect(storage.saveToken("telegram", "   ")).rejects.toThrow(ChannelError);
  });

  it("trims whitespace from tokens before storing", async () => {
    const storage = await createStorage();
    await storage.saveToken("telegram", "  my-token-value-abcdef  ");

    const retrieved = await storage.getToken("telegram");
    expect(retrieved).toBe("my-token-value-abcdef");
  });

  it("does not expose plaintext tokens in list results", async () => {
    const storage = await createStorage();
    const token = "super-secret-bot-token-value";
    await storage.saveToken("telegram", token);

    const listed = await storage.listTokens();
    const entry = listed[0]!;

    // Verify the stored token metadata does not contain the plaintext
    expect(JSON.stringify(entry)).not.toContain(token);
  });
});
