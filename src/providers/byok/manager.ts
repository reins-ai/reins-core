import { ProviderError } from "../../errors";
import { generateId } from "../../conversation/id";
import { err, ok, type Result } from "../../result";
import type { KeyEncryption } from "./crypto";
import type { KeyStorage } from "./storage";
import type { KeyAddRequest, StoredKey } from "./types";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface KeyValidationResult {
  isValid: boolean;
  error?: string;
}

export interface BYOKManagerOptions {
  encryption: KeyEncryption;
  storage: KeyStorage;
  fetchFn?: FetchLike;
}

export class BYOKManager {
  private readonly encryption: KeyEncryption;
  private readonly storage: KeyStorage;
  private readonly fetchFn: FetchLike;

  constructor(options: BYOKManagerOptions) {
    this.encryption = options.encryption;
    this.storage = options.storage;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  public async addKey(request: KeyAddRequest): Promise<StoredKey> {
    const provider = request.provider.trim().toLowerCase();
    const apiKey = request.apiKey.trim();

    if (provider.length === 0) {
      throw new ProviderError("Provider is required to add BYOK key");
    }

    if (apiKey.length === 0) {
      throw new ProviderError("API key is required to add BYOK key");
    }

    const encrypted = await this.encryption.encrypt(apiKey);
    const id = generateId("byok");
    const isValid = await this.validateWithProvider(provider, apiKey);

    const stored: StoredKey = {
      id,
      provider,
      label: request.label?.trim() || `${provider} key`,
      encryptedKey: encrypted.ciphertext,
      iv: encrypted.iv,
      maskedKey: this.maskApiKey(apiKey),
      createdAt: new Date(),
      usageCount: 0,
      isValid,
    };

    await this.storage.save(stored);
    return stored;
  }

  public async removeKey(id: string): Promise<boolean> {
    return this.storage.delete(id);
  }

  public async listKeys(): Promise<StoredKey[]> {
    return this.storage.list();
  }

  public async getDecryptedKey(id: string): Promise<string> {
    const stored = await this.storage.get(id);
    if (!stored) {
      throw new ProviderError(`BYOK key not found: ${id}`);
    }

    return this.encryption.decrypt(stored.encryptedKey, stored.iv);
  }

  public async trackUsage(id: string): Promise<void> {
    await this.storage.updateUsage(id);
  }

  public async testKey(id: string): Promise<boolean> {
    const stored = await this.storage.get(id);
    if (!stored) {
      throw new ProviderError(`BYOK key not found: ${id}`);
    }

    const decryptedKey = await this.encryption.decrypt(stored.encryptedKey, stored.iv);
    const isValid = await this.validateWithProvider(stored.provider, decryptedKey);
    await this.storage.updateValidation(id, isValid);
    return isValid;
  }

  public maskApiKey(key: string): string {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      return "...";
    }

    const separatorIndex = trimmed.indexOf("-");
    const prefix = separatorIndex >= 0 ? trimmed.slice(0, separatorIndex + 1) : trimmed.slice(0, 2);
    const visibleSuffix = trimmed.slice(-4);
    return `${prefix}...${visibleSuffix}`;
  }

  public async validateKey(provider: string, apiKey: string): Promise<Result<void, ProviderError>> {
    let response: Response;
    try {
      response = await this.executeValidationRequest(provider, apiKey);
    } catch (error) {
      return err(
        new ProviderError(
          `Unable to reach ${provider} API for key validation. Check your network connection and try again.`,
          error instanceof Error ? error : undefined,
        ),
      );
    }

    if (!response.ok) {
      const status = response.status;
      if (status === 401) {
        return err(new ProviderError(`${provider} API key is invalid or has been revoked.`));
      }

      if (status === 403) {
        return err(new ProviderError(`${provider} API key does not have sufficient permissions.`));
      }

      return err(new ProviderError(`${provider} API returned an unexpected error (HTTP ${status}).`));
    }

    return ok(undefined);
  }

  private async validateWithProvider(provider: string, apiKey: string): Promise<boolean> {
    const result = await this.validateKey(provider, apiKey);
    return result.ok;
  }

  private executeValidationRequest(provider: string, apiKey: string): Promise<Response> {
    switch (provider) {
      case "openai":
        return this.fetchFn("https://api.openai.com/v1/models", {
          method: "GET",
          headers: {
            Authorization: `Bearer ${apiKey}`,
          },
        });
      case "anthropic":
        return this.fetchFn("https://api.anthropic.com/v1/models?limit=1", {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
        });
      case "google":
        return this.fetchFn(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
          { method: "GET" },
        );
      default:
        throw new ProviderError(`Unsupported BYOK provider validation: ${provider}`);
    }
  }
}
