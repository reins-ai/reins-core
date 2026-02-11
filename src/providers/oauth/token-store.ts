import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { AuthError } from "../../errors";
import type { EncryptedCredentialStore } from "../credentials/store";
import type { OAuthConnectionStatus, OAuthProviderType, OAuthTokens } from "./types";

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

interface SerializedOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: string;
  scope: string;
  tokenType: string;
}

interface EncryptedPayload {
  v: 1;
  salt: string;
  iv: string;
  ciphertext: string;
}

function isExpired(tokens: OAuthTokens): boolean {
  return Date.now() >= tokens.expiresAt.getTime() - EXPIRY_BUFFER_MS;
}

function serializeTokens(tokens: OAuthTokens): SerializedOAuthTokens {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt.toISOString(),
    scope: tokens.scope,
    tokenType: tokens.tokenType,
  };
}

function deserializeTokens(data: SerializedOAuthTokens): OAuthTokens {
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: new Date(data.expiresAt),
    scope: data.scope,
    tokenType: data.tokenType,
  };
}

function toSerializedTokenPayload(value: unknown): SerializedOAuthTokens {
  if (!isRecord(value)) {
    throw new AuthError("Credential-backed OAuth payload is invalid");
  }

  const accessToken = value.accessToken;
  const refreshToken = value.refreshToken;
  const expiresAt = value.expiresAt;
  const scope = value.scope;
  const tokenType = value.tokenType;

  if (
    typeof accessToken !== "string" ||
    (refreshToken !== undefined && typeof refreshToken !== "string") ||
    typeof expiresAt !== "string" ||
    typeof scope !== "string" ||
    typeof tokenType !== "string"
  ) {
    throw new AuthError("Credential-backed OAuth payload has invalid fields");
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    tokenType,
  };
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toSerializedTokens(value: unknown): SerializedOAuthTokens {
  if (!isRecord(value)) {
    throw new AuthError("Stored OAuth token payload is invalid");
  }

  const accessToken = value.accessToken;
  const refreshToken = value.refreshToken;
  const expiresAt = value.expiresAt;
  const scope = value.scope;
  const tokenType = value.tokenType;

  if (
    typeof accessToken !== "string" ||
    (refreshToken !== undefined && typeof refreshToken !== "string") ||
    typeof expiresAt !== "string" ||
    typeof scope !== "string" ||
    typeof tokenType !== "string"
  ) {
    throw new AuthError("Stored OAuth token payload has invalid fields");
  }

  return {
    accessToken,
    refreshToken,
    expiresAt,
    scope,
    tokenType,
  };
}

function toEncryptedPayload(value: unknown): EncryptedPayload {
  if (!isRecord(value)) {
    throw new AuthError("Stored OAuth encrypted payload is invalid");
  }

  const v = value.v;
  const salt = value.salt;
  const iv = value.iv;
  const ciphertext = value.ciphertext;

  if (v !== 1 || typeof salt !== "string" || typeof iv !== "string" || typeof ciphertext !== "string") {
    throw new AuthError("Stored OAuth encrypted payload fields are invalid");
  }

  return { v, salt, iv, ciphertext };
}

export interface OAuthTokenStore {
  save(provider: OAuthProviderType, tokens: OAuthTokens): Promise<void>;
  load(provider: OAuthProviderType): Promise<OAuthTokens | null>;
  delete(provider: OAuthProviderType): Promise<boolean>;
  getStatus(provider: OAuthProviderType): Promise<OAuthConnectionStatus>;
}

export class InMemoryOAuthTokenStore implements OAuthTokenStore {
  private readonly tokens = new Map<OAuthProviderType, OAuthTokens>();

  public async save(provider: OAuthProviderType, tokens: OAuthTokens): Promise<void> {
    this.tokens.set(provider, { ...tokens, expiresAt: new Date(tokens.expiresAt.getTime()) });
  }

  public async load(provider: OAuthProviderType): Promise<OAuthTokens | null> {
    const tokens = this.tokens.get(provider);
    if (!tokens) {
      return null;
    }

    return { ...tokens, expiresAt: new Date(tokens.expiresAt.getTime()) };
  }

  public async delete(provider: OAuthProviderType): Promise<boolean> {
    return this.tokens.delete(provider);
  }

  public async getStatus(provider: OAuthProviderType): Promise<OAuthConnectionStatus> {
    const tokens = await this.load(provider);
    if (!tokens) {
      return "disconnected";
    }

    return isExpired(tokens) ? "expired" : "connected";
  }
}

export class CredentialBackedOAuthTokenStore implements OAuthTokenStore {
  private readonly store: EncryptedCredentialStore;

  constructor(store: EncryptedCredentialStore) {
    this.store = store;
  }

  public async save(provider: OAuthProviderType, tokens: OAuthTokens): Promise<void> {
    const result = await this.store.set({
      id: `oauth_${provider}`,
      provider,
      type: "oauth",
      accountId: provider,
      payload: serializeTokens(tokens),
    });

    if (!result.ok) {
      throw new AuthError(`Unable to persist OAuth credentials for provider ${provider}`, result.error);
    }
  }

  public async load(provider: OAuthProviderType): Promise<OAuthTokens | null> {
    const result = await this.store.get({
      id: `oauth_${provider}`,
      provider,
      type: "oauth",
      accountId: provider,
    });
    if (!result.ok) {
      throw new AuthError(`Unable to load OAuth credentials for provider ${provider}`, result.error);
    }

    if (!result.value) {
      return null;
    }

    const decryptedResult = await this.store.decryptPayload<unknown>(result.value);
    if (!decryptedResult.ok) {
      throw new AuthError(`Unable to decrypt OAuth credentials for provider ${provider}`, decryptedResult.error);
    }

    return deserializeTokens(toSerializedTokenPayload(decryptedResult.value));
  }

  public async delete(provider: OAuthProviderType): Promise<boolean> {
    const result = await this.store.revoke(`oauth_${provider}`);
    if (!result.ok) {
      throw new AuthError(`Unable to revoke OAuth credentials for provider ${provider}`, result.error);
    }

    return result.value;
  }

  public async getStatus(provider: OAuthProviderType): Promise<OAuthConnectionStatus> {
    try {
      const tokens = await this.load(provider);
      if (!tokens) {
        return "disconnected";
      }

      return isExpired(tokens) ? "expired" : "connected";
    } catch {
      return "error";
    }
  }
}

export interface EncryptedFileOAuthTokenStoreOptions {
  directory: string;
  encryptionSecret: string;
}

export class EncryptedFileOAuthTokenStore implements OAuthTokenStore {
  private readonly directory: string;
  private readonly secret: string;

  constructor(options: EncryptedFileOAuthTokenStoreOptions) {
    this.directory = options.directory;
    this.secret = options.encryptionSecret;
  }

  public async save(provider: OAuthProviderType, tokens: OAuthTokens): Promise<void> {
    const path = this.getPath(provider);
    await mkdir(this.directory, { recursive: true });
    await Bun.write(path, await this.encryptPayload(serializeTokens(tokens)));
  }

  public async load(provider: OAuthProviderType): Promise<OAuthTokens | null> {
    const path = this.getPath(provider);
    const file = Bun.file(path);

    if (!(await file.exists())) {
      return null;
    }

    const encrypted = toEncryptedPayload(await file.json());
    const decrypted = await this.decryptPayload(encrypted);
    return deserializeTokens(toSerializedTokens(decrypted));
  }

  public async delete(provider: OAuthProviderType): Promise<boolean> {
    const path = this.getPath(provider);
    const file = Bun.file(path);

    if (!(await file.exists())) {
      return false;
    }

    await rm(path);
    return true;
  }

  public async getStatus(provider: OAuthProviderType): Promise<OAuthConnectionStatus> {
    try {
      const tokens = await this.load(provider);
      if (!tokens) {
        return "disconnected";
      }

      return isExpired(tokens) ? "expired" : "connected";
    } catch {
      return "error";
    }
  }

  private getPath(provider: OAuthProviderType): string {
    return join(this.directory, `${provider}.oauth.json`);
  }

  private async encryptPayload(payload: SerializedOAuthTokens): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveKey(salt);
    const plaintext = new TextEncoder().encode(JSON.stringify(payload));

    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const result: EncryptedPayload = {
      v: 1,
      salt: toBase64(salt),
      iv: toBase64(iv),
      ciphertext: toBase64(new Uint8Array(encrypted)),
    };

    return JSON.stringify(result);
  }

  private async decryptPayload(payload: EncryptedPayload): Promise<unknown> {
    const key = await this.deriveKey(fromBase64(payload.salt));
    const iv = fromBase64(payload.iv);
    const ciphertext = fromBase64(payload.ciphertext);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext),
    );
    const text = new TextDecoder().decode(decrypted);
    return JSON.parse(text) as unknown;
  }

  private async deriveKey(salt: Uint8Array): Promise<CryptoKey> {
    const secretBytes = new TextEncoder().encode(this.secret);
    const material = await crypto.subtle.importKey("raw", secretBytes, "PBKDF2", false, ["deriveKey"]);

    return crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        salt: toArrayBuffer(salt),
        iterations: 100_000,
        hash: "SHA-256",
      },
      material,
      {
        name: "AES-GCM",
        length: 256,
      },
      false,
      ["encrypt", "decrypt"],
    );
  }
}
