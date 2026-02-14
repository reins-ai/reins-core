import type { BYOKManager } from "../../providers/byok/manager";
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
