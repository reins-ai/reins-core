import { ProviderError } from "../../errors";
import type { EncryptedCredentialStore } from "../credentials/store";
import type { CredentialRecord } from "../credentials/types";
import type { StoredKey } from "./types";

function cloneStoredKey(key: StoredKey): StoredKey {
  return {
    ...key,
    createdAt: new Date(key.createdAt.getTime()),
    lastUsedAt: key.lastUsedAt ? new Date(key.lastUsedAt.getTime()) : undefined,
  };
}

function sanitizeForList(key: StoredKey): StoredKey {
  return {
    ...cloneStoredKey(key),
    encryptedKey: "",
    iv: "",
  };
}

export interface KeyStorage {
  save(key: StoredKey): Promise<void>;
  get(id: string): Promise<StoredKey | null>;
  list(): Promise<StoredKey[]>;
  delete(id: string): Promise<boolean>;
  updateUsage(id: string): Promise<void>;
  updateValidation(id: string, isValid: boolean): Promise<void>;
}

interface StoredApiKeyPayload {
  encryptedKey: string;
  iv: string;
  maskedKey: string;
  usageCount: number;
  isValid: boolean;
  lastUsedAt?: string;
}

function toStoredApiKeyPayload(value: unknown): StoredApiKeyPayload {
  if (typeof value !== "object" || value === null) {
    throw new ProviderError("Credential payload for BYOK key is invalid");
  }

  const payload = value as Partial<StoredApiKeyPayload>;
  if (
    typeof payload.encryptedKey !== "string" ||
    typeof payload.iv !== "string" ||
    typeof payload.maskedKey !== "string" ||
    typeof payload.usageCount !== "number" ||
    typeof payload.isValid !== "boolean" ||
    (payload.lastUsedAt !== undefined && typeof payload.lastUsedAt !== "string")
  ) {
    throw new ProviderError("Credential payload for BYOK key has invalid fields");
  }

  return {
    encryptedKey: payload.encryptedKey,
    iv: payload.iv,
    maskedKey: payload.maskedKey,
    usageCount: payload.usageCount,
    isValid: payload.isValid,
    lastUsedAt: payload.lastUsedAt,
  };
}

function toKeyPayload(key: StoredKey): StoredApiKeyPayload {
  return {
    encryptedKey: key.encryptedKey,
    iv: key.iv,
    maskedKey: key.maskedKey,
    usageCount: key.usageCount,
    isValid: key.isValid,
    lastUsedAt: key.lastUsedAt?.toISOString(),
  };
}

export class CredentialBackedKeyStorage implements KeyStorage {
  private readonly store: EncryptedCredentialStore;

  constructor(store: EncryptedCredentialStore) {
    this.store = store;
  }

  public async save(key: StoredKey): Promise<void> {
    const result = await this.store.set({
      id: key.id,
      provider: key.provider,
      type: "api_key",
      metadata: {
        label: key.label,
      },
      payload: toKeyPayload(key),
    });

    if (!result.ok) {
      throw new ProviderError(`Unable to persist BYOK key: ${key.id}`, result.error);
    }
  }

  public async get(id: string): Promise<StoredKey | null> {
    const result = await this.store.get({ id, type: "api_key" });
    if (!result.ok) {
      throw new ProviderError(`Unable to load BYOK key: ${id}`, result.error);
    }

    const record = result.value;
    if (!record) {
      return null;
    }

    return this.toStoredKey(record);
  }

  public async list(): Promise<StoredKey[]> {
    const result = await this.store.list({ type: "api_key" });
    if (!result.ok) {
      throw new ProviderError("Unable to list BYOK keys", result.error);
    }

    const keys: StoredKey[] = [];
    for (const record of result.value) {
      const key = await this.toStoredKey(record);

      keys.push(sanitizeForList(key));
    }

    return keys;
  }

  public async delete(id: string): Promise<boolean> {
    const result = await this.store.revoke(id);
    if (!result.ok) {
      throw new ProviderError(`Unable to delete BYOK key: ${id}`, result.error);
    }

    return result.value;
  }

  public async updateUsage(id: string): Promise<void> {
    const current = await this.get(id);
    if (!current) {
      return;
    }

    current.usageCount += 1;
    current.lastUsedAt = new Date();
    await this.save(current);
  }

  public async updateValidation(id: string, isValid: boolean): Promise<void> {
    const current = await this.get(id);
    if (!current) {
      return;
    }

    current.isValid = isValid;
    await this.save(current);
  }

  private async toStoredKey(record: CredentialRecord): Promise<StoredKey> {
    const decrypted = await this.store.decryptPayload<unknown>(record);

    if (!decrypted.ok) {
      throw new ProviderError(`Unable to decrypt BYOK key payload: ${record.id}`, decrypted.error);
    }

    const payload = toStoredApiKeyPayload(decrypted.value);

    return {
      id: record.id,
      provider: record.provider,
      label: record.metadata?.label ?? `${record.provider} key`,
      encryptedKey: payload.encryptedKey,
      iv: payload.iv,
      maskedKey: payload.maskedKey,
      createdAt: new Date(record.createdAt),
      lastUsedAt: payload.lastUsedAt ? new Date(payload.lastUsedAt) : undefined,
      usageCount: payload.usageCount,
      isValid: payload.isValid,
    };
  }
}

export class InMemoryKeyStorage implements KeyStorage {
  private readonly keys = new Map<string, StoredKey>();

  public async save(key: StoredKey): Promise<void> {
    this.keys.set(key.id, cloneStoredKey(key));
  }

  public async get(id: string): Promise<StoredKey | null> {
    const key = this.keys.get(id);
    return key ? cloneStoredKey(key) : null;
  }

  public async list(): Promise<StoredKey[]> {
    return Array.from(this.keys.values(), sanitizeForList);
  }

  public async delete(id: string): Promise<boolean> {
    return this.keys.delete(id);
  }

  public async updateUsage(id: string): Promise<void> {
    const key = this.keys.get(id);
    if (!key) {
      return;
    }

    key.usageCount += 1;
    key.lastUsedAt = new Date();
  }

  public async updateValidation(id: string, isValid: boolean): Promise<void> {
    const key = this.keys.get(id);
    if (!key) {
      return;
    }

    key.isValid = isValid;
  }
}
