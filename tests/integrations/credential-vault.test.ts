import { describe, expect, it } from "bun:test";

import { IntegrationError } from "../../src/integrations/errors";
import {
  InMemoryCredentialVault,
  IntegrationCredentialVault,
  type IntegrationCredentialVaultOptions,
} from "../../src/integrations/credentials/vault";
import type {
  ApiKeyCredential,
  CredentialVault,
  IntegrationCredential,
  LocalPathCredential,
  OAuthCredential,
} from "../../src/integrations/credentials/types";
import type { KeyEncryption } from "../../src/providers/byok/crypto";
import { EncryptedCredentialStore } from "../../src/providers/credentials/store";
import { ok, err } from "../../src/result";
import { AuthError } from "../../src/errors";
import type { CredentialRecord, CredentialRecordInput, CredentialRecordQuery } from "../../src/providers/credentials/types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function oauthCredential(overrides: Partial<OAuthCredential> = {}): OAuthCredential {
  return {
    type: "oauth",
    access_token: "access-abc-123",
    refresh_token: "refresh-xyz-789",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: ["read", "write"],
    token_type: "Bearer",
    ...overrides,
  };
}

function apiKeyCredential(overrides: Partial<ApiKeyCredential> = {}): ApiKeyCredential {
  return {
    type: "api_key",
    key: "sk-test-key-12345",
    label: "Test API Key",
    ...overrides,
  };
}

function localPathCredential(overrides: Partial<LocalPathCredential> = {}): LocalPathCredential {
  return {
    type: "local_path",
    path: "/home/user/vault",
    validated: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock KeyEncryption — deterministic, reversible, NOT real crypto
// ---------------------------------------------------------------------------

function createMockEncryption(): KeyEncryption {
  return {
    async encrypt(plaintext: string) {
      // Encode to base64 so we can verify it's not stored as plaintext
      const ciphertext = Buffer.from(`encrypted:${plaintext}`).toString("base64");
      const iv = Buffer.from("mock-iv-12bytes!").toString("base64");
      return { ciphertext, iv };
    },
    async decrypt(ciphertext: string, _iv: string) {
      const decoded = Buffer.from(ciphertext, "base64").toString("utf8");
      if (!decoded.startsWith("encrypted:")) {
        throw new Error("Decryption failed: invalid ciphertext");
      }
      return decoded.slice("encrypted:".length);
    },
  } as KeyEncryption;
}

function createFailingEncryption(): KeyEncryption {
  return {
    async encrypt(_plaintext: string) {
      throw new Error("Encryption hardware failure");
    },
    async decrypt(_ciphertext: string, _iv: string) {
      throw new Error("Decryption hardware failure");
    },
  } as KeyEncryption;
}

// ---------------------------------------------------------------------------
// Mock EncryptedCredentialStore — in-memory, no filesystem
// ---------------------------------------------------------------------------

interface MockStoreRecord {
  input: CredentialRecordInput;
  record: CredentialRecord;
  revoked: boolean;
}

function createMockCredentialStore() {
  const records = new Map<string, MockStoreRecord>();

  const store = {
    records,

    async set(input: CredentialRecordInput) {
      const id = input.id ?? `cred_${crypto.randomUUID().replace(/-/g, "")}`;
      const now = Date.now();
      const record: CredentialRecord = {
        id,
        provider: input.provider.trim().toLowerCase(),
        type: input.type,
        accountId: input.accountId?.trim().toLowerCase(),
        metadata: input.metadata,
        encryptedPayload: {
          v: 1,
          salt: "mock-salt",
          iv: "mock-iv",
          ciphertext: JSON.stringify(input.payload),
        },
        createdAt: now,
        updatedAt: now,
        sync: { version: 1, checksum: "mock", updatedAt: now },
      };
      records.set(id, { input, record, revoked: false });
      return ok(record);
    },

    async get(query: CredentialRecordQuery) {
      for (const entry of records.values()) {
        if (entry.revoked) continue;
        const r = entry.record;
        if (query.id && r.id !== query.id) continue;
        if (query.provider && r.provider !== query.provider.trim().toLowerCase()) continue;
        if (query.accountId && r.accountId !== query.accountId.trim().toLowerCase()) continue;
        return ok(r);
      }
      return ok(null);
    },

    async revoke(id: string) {
      const entry = records.get(id);
      if (!entry || entry.revoked) return ok(false);
      entry.revoked = true;
      entry.record.revokedAt = Date.now();
      return ok(true);
    },

    async decryptPayload<T>(record: CredentialRecord) {
      // Return the raw payload that was stored (it's JSON-stringified in encryptedPayload.ciphertext)
      try {
        return ok(JSON.parse(record.encryptedPayload.ciphertext) as T);
      } catch {
        return err(new AuthError("Failed to decrypt payload"));
      }
    },
  } as unknown as EncryptedCredentialStore & { records: Map<string, MockStoreRecord> };

  return store;
}

function createVault(overrides: Partial<IntegrationCredentialVaultOptions> = {}): {
  vault: IntegrationCredentialVault;
  mockStore: ReturnType<typeof createMockCredentialStore>;
  mockEncryption: KeyEncryption;
} {
  const mockStore = createMockCredentialStore();
  const mockEncryption = createMockEncryption();
  const vault = new IntegrationCredentialVault({
    store: overrides.store ?? mockStore,
    encryption: overrides.encryption ?? mockEncryption,
  });
  return { vault, mockStore, mockEncryption };
}

// ===========================================================================
// InMemoryCredentialVault
// ===========================================================================

describe("InMemoryCredentialVault", () => {
  it("stores and retrieves an OAuth credential", async () => {
    const vault = new InMemoryCredentialVault();
    const cred = oauthCredential();

    const storeResult = await vault.store("adapter-alpha", cred);
    expect(storeResult.ok).toBe(true);

    const retrieveResult = await vault.retrieve<OAuthCredential>("adapter-alpha");
    expect(retrieveResult.ok).toBe(true);
    if (!retrieveResult.ok) return;
    expect(retrieveResult.value).not.toBeNull();
    expect(retrieveResult.value!.type).toBe("oauth");
    expect(retrieveResult.value!.access_token).toBe(cred.access_token);
    expect(retrieveResult.value!.refresh_token).toBe(cred.refresh_token);
  });

  it("stores and retrieves an API key credential", async () => {
    const vault = new InMemoryCredentialVault();
    const cred = apiKeyCredential();

    await vault.store("openai", cred);

    const result = await vault.retrieve<ApiKeyCredential>("openai");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.type).toBe("api_key");
    expect(result.value!.key).toBe(cred.key);
    expect(result.value!.label).toBe(cred.label);
  });

  it("stores and retrieves a local path credential", async () => {
    const vault = new InMemoryCredentialVault();
    const cred = localPathCredential();

    await vault.store("obsidian", cred);

    const result = await vault.retrieve<LocalPathCredential>("obsidian");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.type).toBe("local_path");
    expect(result.value!.path).toBe(cred.path);
    expect(result.value!.validated).toBe(true);
  });

  it("returns null when no credential exists", async () => {
    const vault = new InMemoryCredentialVault();

    const result = await vault.retrieve("nonexistent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("revokes an existing credential and returns true", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.store("adapter-alpha", oauthCredential());

    const revokeResult = await vault.revoke("adapter-alpha");
    expect(revokeResult.ok).toBe(true);
    if (!revokeResult.ok) return;
    expect(revokeResult.value).toBe(true);

    const retrieveResult = await vault.retrieve("adapter-alpha");
    expect(retrieveResult.ok).toBe(true);
    if (!retrieveResult.ok) return;
    expect(retrieveResult.value).toBeNull();
  });

  it("returns false when revoking a nonexistent credential", async () => {
    const vault = new InMemoryCredentialVault();

    const result = await vault.revoke("nonexistent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });

  it("hasCredentials returns true when credential exists", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.store("obsidian", localPathCredential());

    const result = await vault.hasCredentials("obsidian");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);
  });

  it("hasCredentials returns false when no credential exists", async () => {
    const vault = new InMemoryCredentialVault();

    const result = await vault.hasCredentials("obsidian");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });

  it("getStatus returns missing when no credential exists", async () => {
    const vault = new InMemoryCredentialVault();

    const result = await vault.getStatus("obsidian");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("missing");
  });

  it("getStatus returns valid for a non-expired OAuth credential", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.store("adapter-alpha", oauthCredential());

    const result = await vault.getStatus("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("valid");
  });

  it("getStatus returns expired for an expired OAuth credential", async () => {
    const vault = new InMemoryCredentialVault();
    const expired = oauthCredential({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await vault.store("adapter-alpha", expired);

    const result = await vault.getStatus("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("expired");
  });

  it("getStatus returns error for an OAuth credential with invalid expiry", async () => {
    const vault = new InMemoryCredentialVault();
    const badExpiry = oauthCredential({ expires_at: "not-a-date" });
    await vault.store("adapter-alpha", badExpiry);

    const result = await vault.getStatus("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("error");
  });

  it("getStatus returns valid for an API key with non-empty key", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.store("openai", apiKeyCredential());

    const result = await vault.getStatus("openai");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("valid");
  });

  it("getStatus returns error for an API key with empty key", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.store("openai", apiKeyCredential({ key: "   " }));

    const result = await vault.getStatus("openai");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("error");
  });

  it("getStatus returns valid for a validated local path", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.store("obsidian", localPathCredential({ validated: true }));

    const result = await vault.getStatus("obsidian");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("valid");
  });

  it("getStatus returns error for an unvalidated local path", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.store("obsidian", localPathCredential({ validated: false }));

    const result = await vault.getStatus("obsidian");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("error");
  });

  it("returns a defensive copy on retrieve (mutations do not affect stored data)", async () => {
    const vault = new InMemoryCredentialVault();
    const cred = oauthCredential();
    await vault.store("adapter-alpha", cred);

    const result1 = await vault.retrieve<OAuthCredential>("adapter-alpha");
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    result1.value!.access_token = "mutated-token";

    const result2 = await vault.retrieve<OAuthCredential>("adapter-alpha");
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value!.access_token).toBe(cred.access_token);
  });

  it("normalizes integration ids (case-insensitive, trimmed)", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.store("  ADAPTER-ALPHA  ", oauthCredential());

    const result = await vault.retrieve("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
  });

  it("returns error for empty integration id on store", async () => {
    const vault = new InMemoryCredentialVault();

    const result = await vault.store("  ", oauthCredential());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
  });

  it("returns error for empty integration id on retrieve", async () => {
    const vault = new InMemoryCredentialVault();

    const result = await vault.retrieve("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
  });

  it("returns error for empty integration id on revoke", async () => {
    const vault = new InMemoryCredentialVault();

    const result = await vault.revoke("  ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
  });

  it("returns error for empty integration id on hasCredentials", async () => {
    const vault = new InMemoryCredentialVault();

    const result = await vault.hasCredentials("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
  });

  it("returns error for empty integration id on getStatus", async () => {
    const vault = new InMemoryCredentialVault();

    const result = await vault.getStatus("  ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
  });
});

// ===========================================================================
// Per-Integration Isolation
// ===========================================================================

describe("InMemoryCredentialVault isolation", () => {
  it("stores credentials for different integrations independently", async () => {
    const vault = new InMemoryCredentialVault();
    const mailCred = oauthCredential({ access_token: "mail-token" });
    const mediaCred = oauthCredential({ access_token: "media-token" });

    await vault.store("adapter-alpha", mailCred);
    await vault.store("adapter-beta", mediaCred);

    const mailResult = await vault.retrieve<OAuthCredential>("adapter-alpha");
    const mediaResult = await vault.retrieve<OAuthCredential>("adapter-beta");

    expect(mailResult.ok).toBe(true);
    expect(mediaResult.ok).toBe(true);
    if (!mailResult.ok || !mediaResult.ok) return;

    expect(mailResult.value!.access_token).toBe("mail-token");
    expect(mediaResult.value!.access_token).toBe("media-token");
  });

  it("revoking one integration does not affect another", async () => {
    const vault = new InMemoryCredentialVault();
    await vault.store("adapter-alpha", oauthCredential());
    await vault.store("adapter-beta", oauthCredential());

    await vault.revoke("adapter-alpha");

    const mailResult = await vault.retrieve("adapter-alpha");
    const mediaResult = await vault.retrieve("adapter-beta");

    expect(mailResult.ok).toBe(true);
    expect(mediaResult.ok).toBe(true);
    if (!mailResult.ok || !mediaResult.ok) return;

    expect(mailResult.value).toBeNull();
    expect(mediaResult.value).not.toBeNull();
  });

  it("different credential types for the same integration are stored independently", async () => {
    const vault = new InMemoryCredentialVault();
    const oauth = oauthCredential();
    const apiKey = apiKeyCredential();

    await vault.store("multi-auth", oauth);
    await vault.store("multi-auth", apiKey);

    // retrieve returns the first found in priority order (oauth > api_key > local_path)
    const result = await vault.retrieve<OAuthCredential>("multi-auth");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.type).toBe("oauth");

    // After revoking, the api_key should still be there
    // But revoke clears all types for the integration
    const hasResult = await vault.hasCredentials("multi-auth");
    expect(hasResult.ok).toBe(true);
    if (!hasResult.ok) return;
    expect(hasResult.value).toBe(true);
  });
});

// ===========================================================================
// IntegrationCredentialVault (encrypted)
// ===========================================================================

describe("IntegrationCredentialVault", () => {
  it("stores and retrieves an OAuth credential through encryption", async () => {
    const { vault } = createVault();
    const cred = oauthCredential();

    const storeResult = await vault.store("adapter-alpha", cred);
    expect(storeResult.ok).toBe(true);

    const retrieveResult = await vault.retrieve<OAuthCredential>("adapter-alpha");
    expect(retrieveResult.ok).toBe(true);
    if (!retrieveResult.ok) return;
    expect(retrieveResult.value).not.toBeNull();
    expect(retrieveResult.value!.type).toBe("oauth");
    expect(retrieveResult.value!.access_token).toBe(cred.access_token);
    expect(retrieveResult.value!.refresh_token).toBe(cred.refresh_token);
    expect(retrieveResult.value!.scopes).toEqual(cred.scopes);
  });

  it("stores and retrieves an API key credential through encryption", async () => {
    const { vault } = createVault();
    const cred = apiKeyCredential();

    await vault.store("openai", cred);

    const result = await vault.retrieve<ApiKeyCredential>("openai");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.type).toBe("api_key");
    expect(result.value!.key).toBe(cred.key);
  });

  it("stores and retrieves a local path credential through encryption", async () => {
    const { vault } = createVault();
    const cred = localPathCredential();

    await vault.store("obsidian", cred);

    const result = await vault.retrieve<LocalPathCredential>("obsidian");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value!.type).toBe("local_path");
    expect(result.value!.path).toBe(cred.path);
    expect(result.value!.validated).toBe(true);
  });

  it("returns null when no credential exists", async () => {
    const { vault } = createVault();

    const result = await vault.retrieve("nonexistent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeNull();
  });

  it("revokes credentials and returns true", async () => {
    const { vault } = createVault();
    await vault.store("adapter-alpha", oauthCredential());

    const revokeResult = await vault.revoke("adapter-alpha");
    expect(revokeResult.ok).toBe(true);
    if (!revokeResult.ok) return;
    expect(revokeResult.value).toBe(true);
  });

  it("returns false when revoking nonexistent credentials", async () => {
    const { vault } = createVault();

    const result = await vault.revoke("nonexistent");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });

  it("hasCredentials returns true after storing", async () => {
    const { vault } = createVault();
    await vault.store("adapter-alpha", oauthCredential());

    const result = await vault.hasCredentials("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(true);
  });

  it("hasCredentials returns false when empty", async () => {
    const { vault } = createVault();

    const result = await vault.hasCredentials("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(false);
  });

  it("getStatus returns missing when no credential exists", async () => {
    const { vault } = createVault();

    const result = await vault.getStatus("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("missing");
  });

  it("getStatus returns valid for non-expired OAuth credential", async () => {
    const { vault } = createVault();
    await vault.store("adapter-alpha", oauthCredential());

    const result = await vault.getStatus("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("valid");
  });

  it("getStatus returns expired for expired OAuth credential", async () => {
    const { vault } = createVault();
    await vault.store("adapter-alpha", oauthCredential({
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    }));

    const result = await vault.getStatus("adapter-alpha");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe("expired");
  });

  it("normalizes integration ids for all operations", async () => {
    const { vault } = createVault();
    await vault.store("  ADAPTER-ALPHA  ", oauthCredential());

    const retrieveResult = await vault.retrieve("adapter-alpha");
    expect(retrieveResult.ok).toBe(true);
    if (!retrieveResult.ok) return;
    expect(retrieveResult.value).not.toBeNull();

    const hasResult = await vault.hasCredentials(" ADAPTER-ALPHA ");
    expect(hasResult.ok).toBe(true);
    if (!hasResult.ok) return;
    expect(hasResult.value).toBe(true);
  });

  it("returns error for empty integration id", async () => {
    const { vault } = createVault();

    const storeResult = await vault.store("", oauthCredential());
    expect(storeResult.ok).toBe(false);
    if (storeResult.ok) return;
    expect(storeResult.error).toBeInstanceOf(IntegrationError);

    const retrieveResult = await vault.retrieve("  ");
    expect(retrieveResult.ok).toBe(false);
  });

  it("returns error when encryption fails during store", async () => {
    const { vault } = createVault({ encryption: createFailingEncryption() });

    const result = await vault.store("adapter-alpha", oauthCredential());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("encrypt");
  });
});

// ===========================================================================
// Encryption Verification
// ===========================================================================

describe("IntegrationCredentialVault encryption verification", () => {
  it("stored data in the underlying store is not plaintext", async () => {
    const { vault, mockStore } = createVault();
    const cred = oauthCredential({ access_token: "super-secret-token-abc" });

    await vault.store("adapter-alpha", cred);

    // Inspect the raw data stored in the mock credential store
    const storedEntries = Array.from(mockStore.records.values());
    expect(storedEntries.length).toBeGreaterThan(0);

    for (const entry of storedEntries) {
      // The payload stored in the credential store should contain encrypted data
      const rawPayload = JSON.stringify(entry.input.payload);

      // The plaintext access token should NOT appear in the raw stored payload
      expect(rawPayload).not.toContain("super-secret-token-abc");

      // The raw payload should contain ciphertext and iv fields (our encryption envelope)
      expect(rawPayload).toContain("ciphertext");
      expect(rawPayload).toContain("iv");
    }
  });

  it("stored data contains encrypted envelope structure", async () => {
    const { vault, mockStore } = createVault();
    await vault.store("adapter-alpha", oauthCredential());

    const storedEntries = Array.from(mockStore.records.values());
    expect(storedEntries.length).toBe(1);

    const payload = storedEntries[0]!.input.payload as Record<string, unknown>;
    expect(payload).toHaveProperty("v", 1);
    expect(payload).toHaveProperty("ciphertext");
    expect(payload).toHaveProperty("iv");
    expect(typeof payload.ciphertext).toBe("string");
    expect(typeof payload.iv).toBe("string");
  });

  it("refresh token is not stored in plaintext", async () => {
    const { vault, mockStore } = createVault();
    const cred = oauthCredential({ refresh_token: "very-secret-refresh-token" });

    await vault.store("adapter-alpha", cred);

    const storedEntries = Array.from(mockStore.records.values());
    const rawPayload = JSON.stringify(storedEntries[0]!.input.payload);
    expect(rawPayload).not.toContain("very-secret-refresh-token");
  });

  it("API key is not stored in plaintext", async () => {
    const { vault, mockStore } = createVault();
    const cred = apiKeyCredential({ key: "sk-super-secret-api-key" });

    await vault.store("openai", cred);

    const storedEntries = Array.from(mockStore.records.values());
    const rawPayload = JSON.stringify(storedEntries[0]!.input.payload);
    expect(rawPayload).not.toContain("sk-super-secret-api-key");
  });

  it("local path is not stored in plaintext", async () => {
    const { vault, mockStore } = createVault();
    const cred = localPathCredential({ path: "/secret/vault/path" });

    await vault.store("obsidian", cred);

    const storedEntries = Array.from(mockStore.records.values());
    const rawPayload = JSON.stringify(storedEntries[0]!.input.payload);
    expect(rawPayload).not.toContain("/secret/vault/path");
  });
});

// ===========================================================================
// IntegrationCredentialVault isolation (encrypted)
// ===========================================================================

describe("IntegrationCredentialVault isolation", () => {
  it("credentials for different integrations are stored under separate keys", async () => {
    const { vault, mockStore } = createVault();

    await vault.store("adapter-alpha", oauthCredential({ access_token: "mail-token" }));
    await vault.store("adapter-beta", oauthCredential({ access_token: "media-token" }));

    // Each integration should have its own record in the store
    const keys = Array.from(mockStore.records.keys());
    const mailKeys = keys.filter((k) => k.includes("adapter-alpha"));
    const mediaKeys = keys.filter((k) => k.includes("adapter-beta"));

    expect(mailKeys.length).toBeGreaterThan(0);
    expect(mediaKeys.length).toBeGreaterThan(0);

    // Verify the key format includes integration id
    for (const key of mailKeys) {
      expect(key).toContain("integration:adapter-alpha:");
    }
    for (const key of mediaKeys) {
      expect(key).toContain("integration:adapter-beta:");
    }
  });

  it("retrieving one integration does not return another's credentials", async () => {
    const { vault } = createVault();

    await vault.store("adapter-alpha", oauthCredential({ access_token: "mail-only" }));
    await vault.store("adapter-beta", oauthCredential({ access_token: "media-only" }));

    const mailResult = await vault.retrieve<OAuthCredential>("adapter-alpha");
    const mediaResult = await vault.retrieve<OAuthCredential>("adapter-beta");

    expect(mailResult.ok).toBe(true);
    expect(mediaResult.ok).toBe(true);
    if (!mailResult.ok || !mediaResult.ok) return;

    expect(mailResult.value!.access_token).toBe("mail-only");
    expect(mediaResult.value!.access_token).toBe("media-only");
  });

  it("revoking one integration does not affect another", async () => {
    const { vault } = createVault();

    await vault.store("adapter-alpha", oauthCredential());
    await vault.store("adapter-beta", oauthCredential());

    await vault.revoke("adapter-alpha");

    const mediaHas = await vault.hasCredentials("adapter-beta");
    expect(mediaHas.ok).toBe(true);
    if (!mediaHas.ok) return;
    expect(mediaHas.value).toBe(true);
  });

  it("credential keys use integration:{id}:{type} format", async () => {
    const { vault, mockStore } = createVault();

    await vault.store("obsidian", localPathCredential());

    const keys = Array.from(mockStore.records.keys());
    expect(keys.some((k) => k === "integration:obsidian:local_path")).toBe(true);
  });
});
