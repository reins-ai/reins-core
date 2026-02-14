import type { Result } from "../../result";
import type {
  SearchProviderName,
  SearchType,
  WebSearchQuery,
  WebSearchResponse,
} from "./types";
import type { WebSearchError } from "./errors";

export interface SearchProviderCapabilities {
  readonly name: SearchProviderName;
  readonly text: boolean;
  readonly image: boolean;
  readonly video: boolean;
  readonly news: boolean;
}

export const BRAVE_CAPABILITIES: SearchProviderCapabilities = {
  name: "brave",
  text: true,
  image: true,
  video: true,
  news: true,
};

export const EXA_CAPABILITIES: SearchProviderCapabilities = {
  name: "exa",
  text: true,
  image: false,
  video: false,
  news: true,
};

export interface SearchProviderAdapter {
  readonly capabilities: SearchProviderCapabilities;
  search(query: WebSearchQuery): Promise<Result<WebSearchResponse, WebSearchError>>;
}

export function supportsSearchType(
  capabilities: SearchProviderCapabilities,
  searchType: SearchType,
): boolean {
  return capabilities[searchType];
}
