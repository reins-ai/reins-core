import { describe, expect, it } from "bun:test";
import { mkdir } from "node:fs/promises";

import {
  EncryptedFileOAuthTokenStore,
  InMemoryOAuthTokenStore,
} from "../../../src/providers/oauth/token-store";
import type { OAuthTokens } from "../../../src/providers/oauth/types";

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

describe("InMemoryOAuthTokenStore", () => {
  it("saves, loads, and deletes tokens", async () => {
    const store = new InMemoryOAuthTokenStore();
    const tokens = makeTokens();

    await store.save("openai", tokens);
    expect(await store.load("openai")).toEqual(tokens);

    expect(await store.delete("openai")).toBe(true);
    expect(await store.load("openai")).toBeNull();
    expect(await store.delete("openai")).toBe(false);
  });

  it("returns expected connection statuses", async () => {
    const store = new InMemoryOAuthTokenStore();

    expect(await store.getStatus("anthropic")).toBe("disconnected");

    await store.save("anthropic", makeTokens({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) }));
    expect(await store.getStatus("anthropic")).toBe("connected");

    await store.save("anthropic", makeTokens({ expiresAt: new Date(Date.now() + 30 * 1000) }));
    expect(await store.getStatus("anthropic")).toBe("expired");
  });
});

describe("EncryptedFileOAuthTokenStore", () => {
  it("persists encrypted tokens and loads them back", async () => {
    const tempDir = await mkdtemp("/tmp/reins-oauth-");
    const store = new EncryptedFileOAuthTokenStore({
      directory: tempDir,
      encryptionSecret: "test-secret",
    });

    const tokens = makeTokens({ accessToken: "super-secret-access" });
    await store.save("openai", tokens);

    const loaded = await store.load("openai");
    expect(loaded).toEqual(tokens);

    const rawContents = await Bun.file(`${tempDir}/openai.oauth.json`).text();
    expect(rawContents.includes("super-secret-access")).toBe(false);

    expect(await store.delete("openai")).toBe(true);
    expect(await store.getStatus("openai")).toBe("disconnected");
  });
});

async function mkdtemp(prefix: string): Promise<string> {
  const suffix = crypto.randomUUID();
  const directory = `${prefix}${suffix}`;
  await mkdir(directory, { recursive: true });
  return directory;
}
