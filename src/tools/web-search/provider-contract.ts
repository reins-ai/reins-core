import { err, ok, type Result } from "../../result";
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

export const BRAVE_CAPABILITIES = {
  name: "brave",
  text: true,
  image: true,
  video: true,
  news: true,
} as const satisfies SearchProviderCapabilities;

export const EXA_CAPABILITIES = {
  name: "exa",
  text: true,
  image: false,
  video: false,
  news: true,
} as const satisfies SearchProviderCapabilities;

export interface SearchProviderAdapter {
  readonly capabilities: SearchProviderCapabilities;
  search(query: WebSearchQuery): Promise<Result<WebSearchResponse, WebSearchError>>;
}

export type SearchProviderResultFactories = {
  readonly ok: typeof ok;
  readonly err: typeof err;
};

export function supportsSearchType(
  capabilities: SearchProviderCapabilities,
  searchType: SearchType,
): boolean {
  return capabilities[searchType];
}
