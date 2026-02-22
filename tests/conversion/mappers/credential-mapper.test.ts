import { describe, expect, it } from "bun:test";

import { CredentialMapper } from "../../../src/conversion/mappers/credential-mapper";
import type { OpenClawAuthProfile } from "../../../src/conversion/types";
import { ok, type Result } from "../../../src/result";
import type { KeychainProvider } from "../../../src/security/keychain-provider";
import type { SecurityError } from "../../../src/security/security-error";

interface SetCall {
  service: string;
  account: string;
}

class MockKeychainProvider implements KeychainProvider {
  public readonly entries = new Map<string, string>();
  public readonly setCalls: SetCall[] = [];

  public async get(service: string, account: string): Promise<Result<string | null, SecurityError>> {
    return ok(this.entries.get(`${service}:${account}`) ?? null);
  }

  public async set(service: string, account: string, secret: string): Promise<Result<void, SecurityError>> {
    this.entries.set(`${service}:${account}`, secret);
    this.setCalls.push({ service, account });
    return ok(undefined);
  }

  public async delete(service: string, account: string): Promise<Result<void, SecurityError>> {
    this.entries.delete(`${service}:${account}`);
    return ok(undefined);
  }
}

function opaqueSecret(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

describe("CredentialMapper", () => {
  it("stores api_key profiles in reins-byok keychain service", async () => {
    const keychain = new MockKeychainProvider();
    const mapper = new CredentialMapper(keychain);
    const profiles: OpenClawAuthProfile[] = [
      { provider: "anthropic", mode: "api_key", key: opaqueSecret() },
      { provider: "openai", mode: "api_key", key: opaqueSecret() },
      { provider: "google", mode: "api_key", key: opaqueSecret() },
    ];

    const result = await mapper.map(profiles);

    expect(result.converted).toBe(3);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(keychain.setCalls).toHaveLength(3);
    expect(keychain.entries.has("reins-byok:anthropic")).toBe(true);
    expect(keychain.entries.has("reins-byok:openai")).toBe(true);
    expect(keychain.entries.has("reins-byok:google")).toBe(true);
  });

  it("stores oauth access and refresh tokens under separate services", async () => {
    const keychain = new MockKeychainProvider();
    const mapper = new CredentialMapper(keychain);
    const oauthProfile = {
      provider: "google",
      mode: "oauth",
      accessToken: opaqueSecret(),
      refreshToken: opaqueSecret(),
    } satisfies OpenClawAuthProfile & { accessToken: string; refreshToken: string };

    const result = await mapper.map([oauthProfile]);

    expect(result.converted).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(keychain.setCalls).toHaveLength(2);
    expect(keychain.entries.has("reins-oauth-access:google:access")).toBe(true);
    expect(keychain.entries.has("reins-oauth-refresh:google:refresh")).toBe(true);
  });

  it("skips profiles missing credential values", async () => {
    const keychain = new MockKeychainProvider();
    const mapper = new CredentialMapper(keychain);
    const profiles: OpenClawAuthProfile[] = [
      { provider: "anthropic", mode: "api_key" },
      { provider: "internal", mode: "token" },
    ];

    const result = await mapper.map(profiles);

    expect(result.converted).toBe(0);
    expect(result.skipped).toBe(2);
    expect(result.errors).toHaveLength(0);
    expect(keychain.setCalls).toHaveLength(0);
  });
});
