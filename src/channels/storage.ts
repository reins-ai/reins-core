import type { ChannelPlatform } from "./types";
import { ChannelError } from "./errors";
import type { EncryptedCredentialStore } from "../providers/credentials/store";
import type { CredentialRecord } from "../providers/credentials/types";

/**
 * Stored channel token metadata returned by list and get operations.
 * Never contains the plaintext token.
 */
export interface StoredChannelToken {
  id: string;
  platform: ChannelPlatform;
  maskedToken: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Channel token payload encrypted inside the credential store.
 */
interface ChannelTokenPayload {
  token: string;
  maskedToken: string;
}

const CHANNEL_PROVIDER_PREFIX = "channel:";
const CHANNEL_CREDENTIAL_TYPE = "token" as const;

function toChannelProvider(platform: ChannelPlatform): string {
  return `${CHANNEL_PROVIDER_PREFIX}${platform}`;
}

function toPlatform(provider: string): ChannelPlatform {
  const platform = provider.slice(CHANNEL_PROVIDER_PREFIX.length);
  if (platform !== "telegram" && platform !== "discord") {
    throw new ChannelError(`Unknown channel platform in provider: ${provider}`);
  }
  return platform;
}

function isChannelProvider(provider: string): boolean {
  return provider.startsWith(CHANNEL_PROVIDER_PREFIX);
}

function toTokenPayload(value: unknown): ChannelTokenPayload {
  if (typeof value !== "object" || value === null) {
    throw new ChannelError("Channel token payload is invalid");
  }

  const payload = value as Partial<ChannelTokenPayload>;
  if (typeof payload.token !== "string" || typeof payload.maskedToken !== "string") {
    throw new ChannelError("Channel token payload has invalid fields");
  }

  return {
    token: payload.token,
    maskedToken: payload.maskedToken,
  };
}

/**
 * Mask a bot token for safe display.
 *
 * Shows the first 3 characters and last 6 characters, masking the rest
 * with asterisks. Short tokens (≤ 9 chars) show only the last 6.
 */
export function maskToken(token: string): string {
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return "***";
  }

  if (trimmed.length <= 6) {
    return "*".repeat(trimmed.length);
  }

  const suffix = trimmed.slice(-6);

  if (trimmed.length <= 9) {
    return `${"*".repeat(trimmed.length - 6)}${suffix}`;
  }

  const prefix = trimmed.slice(0, 3);
  const masked = "*".repeat(Math.min(trimmed.length - 9, 20));
  return `${prefix}${masked}${suffix}`;
}

function toStoredChannelToken(record: CredentialRecord, maskedToken: string): StoredChannelToken {
  return {
    id: record.id,
    platform: toPlatform(record.provider),
    maskedToken,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface ChannelCredentialStorageOptions {
  store: EncryptedCredentialStore;
}

/**
 * Secure storage for channel bot tokens backed by the existing
 * EncryptedCredentialStore. Tokens are encrypted at rest and never
 * exposed in plaintext through list or get operations.
 */
export class ChannelCredentialStorage {
  private readonly store: EncryptedCredentialStore;

  constructor(options: ChannelCredentialStorageOptions) {
    this.store = options.store;
  }

  /**
   * Encrypt and store a bot token for the given platform.
   * Overwrites any existing token for the same platform.
   */
  public async saveToken(platform: ChannelPlatform, token: string): Promise<StoredChannelToken> {
    const trimmed = token.trim();
    if (trimmed.length === 0) {
      throw new ChannelError("Bot token is required");
    }

    const provider = toChannelProvider(platform);
    const masked = maskToken(trimmed);

    const payload: ChannelTokenPayload = {
      token: trimmed,
      maskedToken: masked,
    };

    // Revoke any existing token for this platform before saving
    await this.revokeExisting(provider);

    const result = await this.store.set({
      provider,
      type: CHANNEL_CREDENTIAL_TYPE,
      metadata: { platform },
      payload,
    });

    if (!result.ok) {
      throw new ChannelError(`Unable to save channel token for ${platform}`, result.error);
    }

    return toStoredChannelToken(result.value, masked);
  }

  /**
   * Retrieve and decrypt the bot token for the given platform.
   * Returns null if no token is stored.
   */
  public async getToken(platform: ChannelPlatform): Promise<string | null> {
    const record = await this.findRecord(platform);
    if (!record) {
      return null;
    }

    const decrypted = await this.store.decryptPayload<unknown>(record);
    if (!decrypted.ok) {
      throw new ChannelError(`Unable to decrypt channel token for ${platform}`, decrypted.error);
    }

    const payload = toTokenPayload(decrypted.value);
    return payload.token;
  }

  /**
   * Remove the stored token for the given platform.
   * Returns true if a token was removed, false if none existed.
   */
  public async deleteToken(platform: ChannelPlatform): Promise<boolean> {
    const record = await this.findRecord(platform);
    if (!record) {
      return false;
    }

    const result = await this.store.revoke(record.id);
    if (!result.ok) {
      throw new ChannelError(`Unable to delete channel token for ${platform}`, result.error);
    }

    return result.value;
  }

  /**
   * List all stored channel tokens with masked values.
   * Never returns plaintext tokens.
   */
  public async listTokens(): Promise<StoredChannelToken[]> {
    const result = await this.store.list({
      type: CHANNEL_CREDENTIAL_TYPE,
    });

    if (!result.ok) {
      throw new ChannelError("Unable to list channel tokens", result.error);
    }

    const tokens: StoredChannelToken[] = [];

    for (const record of result.value) {
      if (!isChannelProvider(record.provider)) {
        continue;
      }

      const decrypted = await this.store.decryptPayload<unknown>(record);
      if (!decrypted.ok) {
        throw new ChannelError(
          `Unable to decrypt channel token metadata for ${record.provider}`,
          decrypted.error,
        );
      }

      const payload = toTokenPayload(decrypted.value);
      tokens.push(toStoredChannelToken(record, payload.maskedToken));
    }

    return tokens;
  }

  /**
   * Check whether a token exists for the given platform.
   */
  public async hasToken(platform: ChannelPlatform): Promise<boolean> {
    const record = await this.findRecord(platform);
    return record !== null;
  }

  private async findRecord(platform: ChannelPlatform): Promise<CredentialRecord | null> {
    const provider = toChannelProvider(platform);

    const result = await this.store.get({
      provider,
      type: CHANNEL_CREDENTIAL_TYPE,
    });

    if (!result.ok) {
      throw new ChannelError(`Unable to query channel token for ${platform}`, result.error);
    }

    return result.value;
  }

  private async revokeExisting(provider: string): Promise<void> {
    const existing = await this.store.get({
      provider,
      type: CHANNEL_CREDENTIAL_TYPE,
    });

    if (!existing.ok) {
      return;
    }

    if (existing.value) {
      await this.store.revoke(existing.value.id);
    }
  }
}
