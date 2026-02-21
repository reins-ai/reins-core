import { ProviderError } from "../../errors";
import { createLogger } from "../../logger";
import type { Provider } from "../../types/provider";

const log = createLogger("providers:byok:factory");
import { BYOKManager } from "./manager";
import { BYOKAnthropicProvider } from "./anthropic";
import { BYOKGoogleProvider } from "./google";
import { BYOKOpenAIProvider } from "./openai";

type BYOKProviderType = "anthropic" | "openai" | "google";

function normalizeProviderType(provider: string): BYOKProviderType {
  const normalized = provider.trim().toLowerCase();
  switch (normalized) {
    case "anthropic":
    case "openai":
    case "google":
      return normalized;
    default:
      throw new ProviderError(`Unsupported BYOK provider type: ${provider}`);
  }
}

export class BYOKProviderFactory {
  constructor(private readonly manager: BYOKManager) {}

  public async createProvider(keyId: string): Promise<Provider> {
    const keys = await this.manager.listKeys();
    const key = keys.find((candidate) => candidate.id === keyId);

    if (!key) {
      throw new ProviderError(`BYOK key not found: ${keyId}`);
    }

    const apiKey = await this.manager.getDecryptedKey(keyId);
    const provider = this.createProviderByType(key.provider, apiKey);
    await this.manager.trackUsage(keyId);

    return provider;
  }

  public createProviderByType(provider: string, apiKey: string): Provider {
    const type = normalizeProviderType(provider);

    switch (type) {
      case "anthropic":
        return new BYOKAnthropicProvider(apiKey);
      case "openai":
        return new BYOKOpenAIProvider(apiKey);
      case "google":
        return new BYOKGoogleProvider(apiKey);
    }
  }

  public static async listAvailableProviders(manager: BYOKManager): Promise<string[]> {
    const keys = await manager.listKeys();
    const available = new Set<string>();

    for (const key of keys) {
      if (!key.isValid) {
        continue;
      }

      try {
        available.add(normalizeProviderType(key.provider));
      } catch (e) {
        // Expected: unsupported provider labels may have been persisted
        log.debug("skipping unsupported provider label", { provider: key.provider, error: e instanceof Error ? e.message : String(e) });
      }
    }

    return Array.from(available.values());
  }
}
