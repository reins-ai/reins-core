import type { SearchProviderAdapter } from "./provider-contract";
import { BraveAdapter } from "./providers/brave-adapter";
import { ExaAdapter } from "./providers/exa-adapter";
import type { SearchProviderName } from "./types";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface SearchProviderFactoryOptions {
  fetchFn?: FetchLike;
}

export function createSearchProviderAdapter(
  providerName: SearchProviderName,
  apiKey: string,
  options?: SearchProviderFactoryOptions,
): SearchProviderAdapter {
  switch (providerName) {
    case "brave":
      return new BraveAdapter({
        apiKey,
        fetchFn: options?.fetchFn,
      });
    case "exa":
      return new ExaAdapter({
        apiKey,
        fetchFn: options?.fetchFn,
      });
  }
}
