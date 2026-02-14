import type { BYOKManager } from "../../providers/byok/manager";
import type { EncryptedCredentialStore } from "../../providers/credentials";
import type { SearchKeyProvider } from "./provider-resolver";
import {
  SearchProviderResolver,
  type SearchProviderResolverOptions,
} from "./provider-resolver";
import { WebSearchTool } from "../web-search";

export class BYOKSearchKeyProvider implements SearchKeyProvider {
  constructor(private readonly manager: BYOKManager) {}

  async getKeyForProvider(providerKeyName: string): Promise<string | null> {
    const keys = await this.manager.listKeys();
    const stored = keys.find(
      (key) => key.provider === providerKeyName && key.isValid,
    );

    if (!stored) {
      return null;
    }

    try {
      return await this.manager.getDecryptedKey(stored.id);
    } catch {
      return null;
    }
  }
}

export class CredentialStoreSearchKeyProvider implements SearchKeyProvider {
  constructor(private readonly store: EncryptedCredentialStore) {}

  async getKeyForProvider(providerKeyName: string): Promise<string | null> {
    const result = await this.store.get({
      id: `auth_${providerKeyName}_api_key`,
      provider: providerKeyName,
      type: "api_key",
      accountId: "default",
    });

    if (!result.ok || !result.value) {
      return null;
    }

    try {
      const payloadResult = await this.store.decryptPayload<unknown>(result.value);
      if (!payloadResult.ok) {
        return null;
      }

      const payload = payloadResult.value;
      if (typeof payload !== "object" || payload === null) {
        return null;
      }

      const key = (payload as Record<string, unknown>).key;
      return typeof key === "string" ? key : null;
    } catch {
      return null;
    }
  }
}

export interface CreateWebSearchToolOptions {
  byokManager: BYOKManager;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export function createWebSearchTool(options: CreateWebSearchToolOptions): WebSearchTool {
  const keyProvider = new BYOKSearchKeyProvider(options.byokManager);

  const resolverOptions: SearchProviderResolverOptions = {
    keyProvider,
    ...(options.fetchFn ? { factoryOptions: { fetchFn: options.fetchFn } } : {}),
  };

  const resolver = new SearchProviderResolver(resolverOptions);

  return new WebSearchTool({ resolver });
}

export interface CreateWebSearchToolFromCredentialsOptions {
  credentialStore: EncryptedCredentialStore;
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export function createWebSearchToolFromCredentials(
  options: CreateWebSearchToolFromCredentialsOptions,
): WebSearchTool {
  const keyProvider = new CredentialStoreSearchKeyProvider(options.credentialStore);

  const resolverOptions: SearchProviderResolverOptions = {
    keyProvider,
    ...(options.fetchFn ? { factoryOptions: { fetchFn: options.fetchFn } } : {}),
  };

  const resolver = new SearchProviderResolver(resolverOptions);

  return new WebSearchTool({ resolver });
}
