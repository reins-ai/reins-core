export type SearchType = "text" | "image" | "video" | "news";

export type SearchProviderName = "exa" | "brave";

/**
 * Normalized query input used by all web search providers.
 */
export interface WebSearchQuery {
  query: string;
  searchType: SearchType;
  limit?: number;
  offset?: number;
}

/**
 * Shared result fields normalized across all search result types.
 */
export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  score?: number;
  publishedAt?: string;
}

/**
 * Normalized text search result item.
 */
export interface TextSearchResult extends WebSearchResultItem {
  type: "text";
  content?: string;
  author?: string;
}

/**
 * Normalized image search result item.
 */
export interface ImageSearchResult extends WebSearchResultItem {
  type: "image";
  imageUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
  source?: string;
}

/**
 * Normalized video search result item.
 */
export interface VideoSearchResult extends WebSearchResultItem {
  type: "video";
  thumbnailUrl?: string;
  duration?: string;
  source?: string;
  viewCount?: number;
}

/**
 * Normalized news search result item.
 */
export interface NewsSearchResult extends WebSearchResultItem {
  type: "news";
  source: string;
  imageUrl?: string;
}

export type SearchResultItem =
  | TextSearchResult
  | ImageSearchResult
  | VideoSearchResult
  | NewsSearchResult;

export type WebSearchResult = SearchResultItem;

/**
 * Provider-agnostic web search response containing normalized results.
 */
export interface WebSearchResponse {
  provider: SearchProviderName;
  query: string;
  searchType: SearchType;
  results: SearchResultItem[];
  totalResults?: number;
}
