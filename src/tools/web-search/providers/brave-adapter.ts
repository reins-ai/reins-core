import { err, ok, type Result } from "../../../result";
import type { WebSearchQuery, WebSearchResponse } from "../types";
import { WebSearchError } from "../errors";
import {
  BRAVE_CAPABILITIES,
  supportsSearchType,
  type SearchProviderAdapter,
} from "../provider-contract";
import {
  mapBraveTextResults,
  mapBraveImageResults,
  mapBraveVideoResults,
  mapBraveNewsResults,
} from "./brave-mapper";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface BraveAdapterOptions {
  apiKey: string;
  fetchFn?: FetchLike;
  baseUrl?: string;
}

export class BraveAdapter implements SearchProviderAdapter {
  readonly capabilities = BRAVE_CAPABILITIES;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(options: BraveAdapterOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.search.brave.com/res/v1";
  }

  async search(query: WebSearchQuery): Promise<Result<WebSearchResponse, WebSearchError>> {
    if (!supportsSearchType(this.capabilities, query.searchType)) {
      return err(new WebSearchError(
        `Brave does not support search type: ${query.searchType}`,
      ));
    }

    try {
      switch (query.searchType) {
        case "text":
          return await this.searchText(query);
        case "image":
          return await this.searchImages(query);
        case "video":
          return await this.searchVideos(query);
        case "news":
          return await this.searchNews(query);
      }
    } catch (error) {
      return err(new WebSearchError(
        `Brave search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        error instanceof Error ? error : undefined,
      ));
    }
  }

  private async searchText(query: WebSearchQuery): Promise<Result<WebSearchResponse, WebSearchError>> {
    const params = new URLSearchParams({ q: query.query });
    if (query.limit) params.set("count", String(query.limit));
    if (query.offset) params.set("offset", String(query.offset));

    const response = await this.fetchFn(`${this.baseUrl}/web/search?${params}`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const data = await response.json() as Record<string, unknown>;
    return ok({
      provider: "brave",
      query: query.query,
      searchType: "text",
      results: mapBraveTextResults(data),
      totalResults: getNestedNumber(data, "web", "totalEstimatedMatches"),
    });
  }

  private async searchImages(query: WebSearchQuery): Promise<Result<WebSearchResponse, WebSearchError>> {
    const params = new URLSearchParams({ q: query.query });
    if (query.limit) params.set("count", String(query.limit));

    const response = await this.fetchFn(`${this.baseUrl}/images/search?${params}`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const data = await response.json() as Record<string, unknown>;
    return ok({
      provider: "brave",
      query: query.query,
      searchType: "image",
      results: mapBraveImageResults(data),
    });
  }

  private async searchVideos(query: WebSearchQuery): Promise<Result<WebSearchResponse, WebSearchError>> {
    const params = new URLSearchParams({ q: query.query });
    if (query.limit) params.set("count", String(query.limit));

    const response = await this.fetchFn(`${this.baseUrl}/videos/search?${params}`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const data = await response.json() as Record<string, unknown>;
    return ok({
      provider: "brave",
      query: query.query,
      searchType: "video",
      results: mapBraveVideoResults(data),
    });
  }

  private async searchNews(query: WebSearchQuery): Promise<Result<WebSearchResponse, WebSearchError>> {
    const params = new URLSearchParams({ q: query.query });
    if (query.limit) params.set("count", String(query.limit));

    const response = await this.fetchFn(`${this.baseUrl}/news/search?${params}`, {
      headers: this.buildHeaders(),
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const data = await response.json() as Record<string, unknown>;
    return ok({
      provider: "brave",
      query: query.query,
      searchType: "news",
      results: mapBraveNewsResults(data),
    });
  }

  private buildHeaders(): Record<string, string> {
    return {
      "X-Subscription-Token": this.apiKey,
      "Accept": "application/json",
    };
  }

  private handleErrorResponse(response: Response): Result<never, WebSearchError> {
    const status = response.status;
    if (status === 401) {
      return err(new WebSearchError("Brave API key is invalid or missing"));
    }
    if (status === 429) {
      return err(new WebSearchError("Brave API rate limit exceeded"));
    }
    return err(new WebSearchError(`Brave API error (HTTP ${status})`));
  }
}

function getNestedNumber(obj: unknown, ...keys: string[]): number | undefined {
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "number" ? current : undefined;
}
