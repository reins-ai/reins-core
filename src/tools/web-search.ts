import type { Tool, ToolContext, ToolDefinition, ToolErrorDetail, ToolResult } from "../types";
import type { SearchType, WebSearchQuery } from "./web-search/types";
import { supportsSearchType } from "./web-search/provider-contract";
import { isValidSearchType } from "./web-search/tool-contract";
import { mapSearchErrorToToolError, createUnsupportedTypeError } from "./web-search/error-mapper";
import type { SearchProviderResolver } from "./web-search/provider-resolver";
import { readUserConfig } from "../config/user-config";

export interface WebSearchToolOptions {
  resolver: SearchProviderResolver;
  defaultSearchType?: SearchType;
}

export class WebSearchTool implements Tool {
  definition: ToolDefinition = {
    name: "web_search",
    description:
      "Search the web for current information. Supports text, image, video, and news searches using the configured search provider.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["search"],
        },
        query: {
          type: "string",
          description: "The search query string.",
        },
        searchType: {
          type: "string",
          description:
            "Type of search to perform. Defaults to 'text' if not specified.",
          enum: ["text", "image", "video", "news"],
        },
        limit: {
          type: "number",
          description: "Maximum number of results to return.",
        },
      },
      required: ["action", "query"],
    },
  };

  private readonly resolver: SearchProviderResolver;
  private readonly defaultSearchType: SearchType;

  constructor(options: WebSearchToolOptions) {
    this.resolver = options.resolver;
    this.defaultSearchType = options.defaultSearchType ?? "text";
  }

  async execute(
    args: Record<string, unknown>,
    _context: ToolContext,
  ): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";
    const action = this.readString(args.action);

    if (action !== "search") {
      return this.errorResult(
        callId,
        "Missing or invalid 'action' argument. Expected: 'search'.",
      );
    }

    try {
      return await this.handleSearch(callId, args);
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private async handleSearch(
    callId: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const query = this.requireString(
      args.query,
      "'query' is required for search action.",
    );

    const rawSearchType = args.searchType;
    const searchType =
      rawSearchType !== undefined
        ? this.validateSearchType(rawSearchType)
        : this.defaultSearchType;

    const limit = this.optionalPositiveInteger(
      args.limit,
      "'limit' must be a positive integer.",
    );

    const configResult = await readUserConfig();
    const preference = configResult.ok && configResult.value
      ? configResult.value.provider.search?.provider
      : undefined;

    const adapterResult = await this.resolver.resolveFromPreference(preference);
    if (!adapterResult.ok) {
      return this.errorResultWithDetail(
        callId,
        adapterResult.error.message,
        mapSearchErrorToToolError(adapterResult.error),
      );
    }
    const adapter = adapterResult.value;

    if (!supportsSearchType(adapter.capabilities, searchType)) {
      return this.errorResultWithDetail(
        callId,
        `Provider does not support ${searchType} search.`,
        createUnsupportedTypeError(
          adapter.capabilities.name,
          searchType,
          adapter.capabilities,
        ),
      );
    }

    const searchQuery: WebSearchQuery = {
      query,
      searchType,
      limit,
    };

    const searchResult = await adapter.search(searchQuery);
    if (!searchResult.ok) {
      return this.errorResultWithDetail(
        callId,
        searchResult.error.message,
        mapSearchErrorToToolError(
          searchResult.error,
          adapter.capabilities.name,
        ),
      );
    }

    return this.successResult(callId, {
      action: "search",
      searchType,
      provider: searchResult.value.provider,
      query: searchResult.value.query,
      results: searchResult.value.results,
      totalResults: searchResult.value.totalResults,
      count: searchResult.value.results.length,
    });
  }

  private validateSearchType(value: unknown): SearchType {
    if (isValidSearchType(value)) {
      return value;
    }
    throw new Error(
      `Invalid searchType: '${String(value)}'. Must be one of: text, image, video, news.`,
    );
  }

  private successResult(callId: string, result: unknown): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result,
    };
  }

  private errorResult(callId: string, error: string): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result: null,
      error,
    };
  }

  private errorResultWithDetail(
    callId: string,
    error: string,
    errorDetail: ToolErrorDetail,
  ): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result: null,
      error,
      errorDetail,
    };
  }

  private readString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private requireString(value: unknown, message: string): string {
    const read = this.readString(value);
    if (!read) {
      throw new Error(message);
    }
    return read;
  }

  private optionalPositiveInteger(
    value: unknown,
    message: string,
  ): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(message);
    }

    return value;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Web search tool execution failed.";
  }
}
