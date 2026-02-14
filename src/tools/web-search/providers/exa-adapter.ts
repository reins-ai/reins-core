import { err, ok, type Result } from "../../../result";
import type { WebSearchQuery, WebSearchResponse } from "../types";
import { WebSearchError } from "../errors";
import {
  EXA_CAPABILITIES,
  supportsSearchType,
  type SearchProviderAdapter,
} from "../provider-contract";
import { mapExaTextResults, mapExaNewsResults } from "./exa-mapper";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ExaAdapterOptions {
  apiKey: string;
  fetchFn?: FetchLike;
  baseUrl?: string;
}

export class ExaAdapter implements SearchProviderAdapter {
  readonly capabilities = EXA_CAPABILITIES;
  private readonly apiKey: string;
  private readonly fetchFn: FetchLike;
  private readonly baseUrl: string;

  constructor(options: ExaAdapterOptions) {
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetchFn ?? fetch;
    this.baseUrl = options.baseUrl ?? "https://api.exa.ai";
  }

  async search(query: WebSearchQuery): Promise<Result<WebSearchResponse, WebSearchError>> {
    if (!supportsSearchType(this.capabilities, query.searchType)) {
      return err(new WebSearchError(
        `Exa does not support search type: ${query.searchType}. Supported types: text, news.`,
      ));
    }

    try {
      switch (query.searchType) {
        case "text":
          return await this.searchText(query);
        case "news":
          return await this.searchNews(query);
        default:
          return err(new WebSearchError(
            `Exa does not support search type: ${query.searchType}`,
          ));
      }
    } catch (error) {
      return err(new WebSearchError(
        `Exa search failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        error instanceof Error ? error : undefined,
      ));
    }
  }

  private async searchText(
    query: WebSearchQuery,
  ): Promise<Result<WebSearchResponse, WebSearchError>> {
    const body = this.buildRequestBody(query);
    const response = await this.fetchFn(`${this.baseUrl}/search`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const data = await response.json() as Record<string, unknown>;
    return ok({
      provider: "exa",
      query: query.query,
      searchType: "text",
      results: mapExaTextResults(data),
    });
  }

  private async searchNews(
    query: WebSearchQuery,
  ): Promise<Result<WebSearchResponse, WebSearchError>> {
    const body = { ...this.buildRequestBody(query), category: "news" };
    const response = await this.fetchFn(`${this.baseUrl}/search`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      return this.handleErrorResponse(response);
    }

    const data = await response.json() as Record<string, unknown>;
    return ok({
      provider: "exa",
      query: query.query,
      searchType: "news",
      results: mapExaNewsResults(data),
    });
  }

  private buildRequestBody(query: WebSearchQuery): Record<string, unknown> {
    return {
      query: query.query,
      numResults: query.limit ?? 10,
      type: "neural",
      contents: {
        text: true,
        highlights: true,
      },
    };
  }

  private buildHeaders(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
  }

  private async handleErrorResponse(
    response: Response,
  ): Promise<Result<never, WebSearchError>> {
    const status = response.status;
    if (status === 401) {
      return err(new WebSearchError("Exa API key is invalid or missing"));
    }
    if (status === 429) {
      return err(new WebSearchError("Exa API rate limit exceeded"));
    }
    return err(new WebSearchError(`Exa API error (HTTP ${status})`));
  }
}
