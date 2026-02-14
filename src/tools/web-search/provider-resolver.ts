import { err, ok, type Result } from "../../result";
import { WebSearchError } from "./errors";
import type { SearchProviderAdapter } from "./provider-contract";
import {
  createSearchProviderAdapter,
  type SearchProviderFactoryOptions,
} from "./provider-factory";
import type { SearchProviderName } from "./types";

export const DEFAULT_SEARCH_PROVIDER: SearchProviderName = "brave";

export const SEARCH_PROVIDER_KEY_NAMES: Record<SearchProviderName, string> = {
  brave: "brave_search",
  exa: "exa",
};

export interface SearchKeyProvider {
  getKeyForProvider(providerKeyName: string): Promise<string | null>;
}

export interface SearchProviderResolverOptions {
  keyProvider: SearchKeyProvider;
  factoryOptions?: SearchProviderFactoryOptions;
}

export function resolveSearchProviderName(preference?: string): SearchProviderName {
  if (preference === "exa" || preference === "brave") {
    return preference;
  }

  return DEFAULT_SEARCH_PROVIDER;
}

export class SearchProviderResolver {
  private readonly keyProvider: SearchKeyProvider;
  private readonly factoryOptions?: SearchProviderFactoryOptions;

  constructor(options: SearchProviderResolverOptions) {
    this.keyProvider = options.keyProvider;
    this.factoryOptions = options.factoryOptions;
  }

  async resolve(
    providerName: SearchProviderName,
  ): Promise<Result<SearchProviderAdapter, WebSearchError>> {
    const keyName = SEARCH_PROVIDER_KEY_NAMES[providerName];
    const apiKey = await this.keyProvider.getKeyForProvider(keyName);

    if (!apiKey) {
      return err(new WebSearchError(
        `No API key configured for search provider: ${providerName}. Add a "${keyName}" key via BYOK settings.`,
      ));
    }

    const adapter = createSearchProviderAdapter(
      providerName,
      apiKey,
      this.factoryOptions,
    );

    return ok(adapter);
  }

  async resolveFromPreference(
    preference?: string,
  ): Promise<Result<SearchProviderAdapter, WebSearchError>> {
    const providerName = resolveSearchProviderName(preference);
    return this.resolve(providerName);
  }
}
