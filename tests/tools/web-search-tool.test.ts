import { describe, expect, it } from "bun:test";

import { WebSearchTool } from "../../src/tools/web-search";
import {
  SearchProviderResolver,
  type SearchKeyProvider,
} from "../../src/tools/web-search/provider-resolver";
import type { ToolContext } from "../../src/types";

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const toolContext: ToolContext = {
  conversationId: "conv-test",
  userId: "user-test",
};

function createMockFetch(response: object, status = 200): FetchLike {
  return async () =>
    new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    });
}

function createMockKeyProvider(
  keys: Record<string, string>,
): SearchKeyProvider {
  return {
    async getKeyForProvider(name) {
      return keys[name] ?? null;
    },
  };
}

function createTool(
  keys: Record<string, string>,
  fetchFn: FetchLike,
): WebSearchTool {
  const keyProvider = createMockKeyProvider(keys);
  const resolver = new SearchProviderResolver({
    keyProvider,
    factoryOptions: { fetchFn },
  });
  return new WebSearchTool({ resolver });
}

/**
 * Creates a WebSearchTool backed by an Exa adapter (via a resolver that
 * resolves to exa) so we can test exa-specific capability limits.
 */
function createExaTool(fetchFn: FetchLike): WebSearchTool {
  const keyProvider = createMockKeyProvider({ exa: "test-exa-key" });
  const resolver = new SearchProviderResolver({
    keyProvider,
    factoryOptions: { fetchFn },
  });
  // Construct with exa preference by wrapping resolveFromPreference
  const originalResolve = resolver.resolveFromPreference.bind(resolver);
  resolver.resolveFromPreference = () => originalResolve("exa");
  return new WebSearchTool({ resolver });
}

// --- Brave-like mock response payloads ---

const braveTextResponse = {
  web: {
    results: [
      {
        title: "TypeScript Handbook",
        url: "https://typescriptlang.org/docs",
        description: "The TypeScript handbook is a comprehensive guide.",
        page_age: "2024-01-15",
      },
      {
        title: "TypeScript GitHub",
        url: "https://github.com/microsoft/TypeScript",
        description: "TypeScript is a typed superset of JavaScript.",
      },
    ],
    totalEstimatedMatches: 1200,
  },
};

const braveNewsResponse = {
  results: [
    {
      title: "TypeScript 6.0 Released",
      url: "https://news.example.com/ts6",
      description: "Major new release with exciting features.",
      age: "2h ago",
      meta_url: { hostname: "news.example.com" },
      thumbnail: { src: "https://img.example.com/ts6.jpg" },
    },
  ],
};

const braveImageResponse = {
  results: [
    {
      title: "TypeScript Logo",
      url: "https://images.example.com/ts-logo-page",
      properties: { url: "https://images.example.com/ts-logo.png" },
      thumbnail: { src: "https://thumb.example.com/ts-logo.jpg", width: 150, height: 150 },
      source: "example.com",
    },
  ],
};

const braveVideoResponse = {
  results: [
    {
      title: "TypeScript Tutorial",
      url: "https://youtube.com/watch?v=abc123",
      description: "Learn TypeScript in 30 minutes.",
      thumbnail: { src: "https://i.ytimg.com/vi/abc123/default.jpg" },
      video: { duration: "30:00", views: 50000, publisher: "TechChannel" },
      meta_url: { hostname: "youtube.com" },
    },
  ],
};

describe("WebSearchTool", () => {
  describe("definition", () => {
    it("has name web_search", () => {
      const tool = createTool({}, createMockFetch({}));
      expect(tool.definition.name).toBe("web_search");
    });

    it("has required parameters action and query", () => {
      const tool = createTool({}, createMockFetch({}));
      expect(tool.definition.parameters.required).toContain("action");
      expect(tool.definition.parameters.required).toContain("query");
    });

    it("includes searchType and limit in parameters", () => {
      const tool = createTool({}, createMockFetch({}));
      const props = tool.definition.parameters.properties;
      expect(props).toBeDefined();
      expect(props!.searchType).toBeDefined();
      expect(props!.searchType!.enum).toEqual(["text", "image", "video", "news"]);
      expect(props!.limit).toBeDefined();
      expect(props!.limit!.type).toBe("number");
    });
  });

  describe("execute - success cases", () => {
    it("text search returns normalized results", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch(braveTextResponse),
      );

      const result = await tool.execute(
        { callId: "call-1", action: "search", query: "typescript" },
        toolContext,
      );

      expect(result.callId).toBe("call-1");
      expect(result.name).toBe("web_search");
      expect(result.error).toBeUndefined();

      const data = result.result as Record<string, unknown>;
      expect(data.action).toBe("search");
      expect(data.searchType).toBe("text");
      expect(data.provider).toBe("brave");
      expect(data.query).toBe("typescript");
      expect(data.count).toBe(2);
      expect(data.totalResults).toBe(1200);

      const results = data.results as Array<Record<string, unknown>>;
      expect(results[0]!.type).toBe("text");
      expect(results[0]!.title).toBe("TypeScript Handbook");
      expect(results[0]!.url).toBe("https://typescriptlang.org/docs");
      expect(results[0]!.snippet).toBe("The TypeScript handbook is a comprehensive guide.");
    });

    it("news search returns normalized results", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch(braveNewsResponse),
      );

      const result = await tool.execute(
        { callId: "call-news", action: "search", query: "typescript", searchType: "news" },
        toolContext,
      );

      expect(result.callId).toBe("call-news");
      expect(result.name).toBe("web_search");
      expect(result.error).toBeUndefined();

      const data = result.result as Record<string, unknown>;
      expect(data.searchType).toBe("news");
      expect(data.provider).toBe("brave");
      expect(data.count).toBe(1);

      const results = data.results as Array<Record<string, unknown>>;
      expect(results[0]!.type).toBe("news");
      expect(results[0]!.title).toBe("TypeScript 6.0 Released");
      expect(results[0]!.source).toBe("news.example.com");
    });

    it("image search returns normalized results (Brave only)", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch(braveImageResponse),
      );

      const result = await tool.execute(
        { callId: "call-img", action: "search", query: "typescript logo", searchType: "image" },
        toolContext,
      );

      expect(result.callId).toBe("call-img");
      expect(result.name).toBe("web_search");
      expect(result.error).toBeUndefined();

      const data = result.result as Record<string, unknown>;
      expect(data.searchType).toBe("image");
      expect(data.provider).toBe("brave");
      expect(data.count).toBe(1);

      const results = data.results as Array<Record<string, unknown>>;
      expect(results[0]!.type).toBe("image");
      expect(results[0]!.title).toBe("TypeScript Logo");
      expect(results[0]!.imageUrl).toBe("https://images.example.com/ts-logo.png");
    });

    it("video search returns normalized results (Brave only)", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch(braveVideoResponse),
      );

      const result = await tool.execute(
        { callId: "call-vid", action: "search", query: "typescript tutorial", searchType: "video" },
        toolContext,
      );

      expect(result.callId).toBe("call-vid");
      expect(result.name).toBe("web_search");
      expect(result.error).toBeUndefined();

      const data = result.result as Record<string, unknown>;
      expect(data.searchType).toBe("video");
      expect(data.provider).toBe("brave");
      expect(data.count).toBe(1);

      const results = data.results as Array<Record<string, unknown>>;
      expect(results[0]!.type).toBe("video");
      expect(results[0]!.title).toBe("TypeScript Tutorial");
      expect(results[0]!.duration).toBe("30:00");
      expect(results[0]!.source).toBe("youtube.com");
    });

    it("defaults to text search when searchType not provided", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch(braveTextResponse),
      );

      const result = await tool.execute(
        { callId: "call-default", action: "search", query: "typescript" },
        toolContext,
      );

      expect(result.error).toBeUndefined();
      const data = result.result as Record<string, unknown>;
      expect(data.searchType).toBe("text");
    });

    it("respects limit parameter", async () => {
      let capturedUrl = "";
      const fetchFn: FetchLike = async (input) => {
        capturedUrl = typeof input === "string" ? input : input.toString();
        return new Response(JSON.stringify(braveTextResponse), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };

      const tool = createTool({ brave_search: "test-key" }, fetchFn);

      await tool.execute(
        { callId: "call-limit", action: "search", query: "typescript", limit: 5 },
        toolContext,
      );

      expect(capturedUrl).toContain("count=5");
    });
  });

  describe("execute - error cases", () => {
    it("returns error when action is not search", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch({}),
      );

      const result = await tool.execute(
        { callId: "call-bad-action", action: "delete", query: "test" },
        toolContext,
      );

      expect(result.callId).toBe("call-bad-action");
      expect(result.name).toBe("web_search");
      expect(result.result).toBeNull();
      expect(result.error).toContain("action");
    });

    it("returns error when action is missing", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch({}),
      );

      const result = await tool.execute(
        { callId: "call-no-action", query: "test" },
        toolContext,
      );

      expect(result.callId).toBe("call-no-action");
      expect(result.name).toBe("web_search");
      expect(result.result).toBeNull();
      expect(result.error).toContain("action");
    });

    it("returns error when query is missing", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch({}),
      );

      const result = await tool.execute(
        { callId: "call-no-query", action: "search" },
        toolContext,
      );

      expect(result.callId).toBe("call-no-query");
      expect(result.name).toBe("web_search");
      expect(result.result).toBeNull();
      expect(result.error).toContain("query");
    });

    it("returns error when query is empty string", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch({}),
      );

      const result = await tool.execute(
        { callId: "call-empty-query", action: "search", query: "" },
        toolContext,
      );

      expect(result.callId).toBe("call-empty-query");
      expect(result.name).toBe("web_search");
      expect(result.result).toBeNull();
      expect(result.error).toContain("query");
    });

    it("returns error with errorDetail when provider key is missing", async () => {
      const tool = createTool({}, createMockFetch({}));

      const result = await tool.execute(
        { callId: "call-no-key", action: "search", query: "test" },
        toolContext,
      );

      expect(result.callId).toBe("call-no-key");
      expect(result.name).toBe("web_search");
      expect(result.result).toBeNull();
      expect(result.error).toBeDefined();
      expect(result.errorDetail).toBeDefined();
      expect(result.errorDetail!.code).toBe("WEB_SEARCH_AUTH_FAILED");
      expect(result.errorDetail!.retryable).toBe(false);
    });

    it("returns error with errorDetail for unsupported search type (exa + image)", async () => {
      const tool = createExaTool(createMockFetch({}));

      const result = await tool.execute(
        { callId: "call-exa-img", action: "search", query: "logo", searchType: "image" },
        toolContext,
      );

      expect(result.callId).toBe("call-exa-img");
      expect(result.name).toBe("web_search");
      expect(result.result).toBeNull();
      expect(result.error).toContain("does not support");
      expect(result.errorDetail).toBeDefined();
      expect(result.errorDetail!.code).toBe("WEB_SEARCH_UNSUPPORTED_TYPE");
      expect(result.errorDetail!.retryable).toBe(false);
    });

    it("returns error when searchType is invalid string", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch({}),
      );

      const result = await tool.execute(
        { callId: "call-bad-type", action: "search", query: "test", searchType: "podcast" },
        toolContext,
      );

      expect(result.callId).toBe("call-bad-type");
      expect(result.name).toBe("web_search");
      expect(result.result).toBeNull();
      expect(result.error).toContain("searchType");
    });

    it("returns error with errorDetail when provider returns HTTP 401", async () => {
      const tool = createTool(
        { brave_search: "bad-key" },
        createMockFetch({ error: "Unauthorized" }, 401),
      );

      const result = await tool.execute(
        { callId: "call-401", action: "search", query: "test" },
        toolContext,
      );

      expect(result.callId).toBe("call-401");
      expect(result.name).toBe("web_search");
      expect(result.result).toBeNull();
      expect(result.error).toBeDefined();
      expect(result.errorDetail).toBeDefined();
      expect(result.errorDetail!.code).toBe("WEB_SEARCH_AUTH_FAILED");
      expect(result.errorDetail!.retryable).toBe(false);
    });

    it("returns error with errorDetail when provider returns HTTP 429", async () => {
      const tool = createTool(
        { brave_search: "test-key" },
        createMockFetch({ error: "Rate limited" }, 429),
      );

      const result = await tool.execute(
        { callId: "call-429", action: "search", query: "test" },
        toolContext,
      );

      expect(result.callId).toBe("call-429");
      expect(result.name).toBe("web_search");
      expect(result.result).toBeNull();
      expect(result.error).toBeDefined();
      expect(result.errorDetail).toBeDefined();
      expect(result.errorDetail!.code).toBe("WEB_SEARCH_RATE_LIMITED");
      expect(result.errorDetail!.retryable).toBe(true);
    });
  });
});
