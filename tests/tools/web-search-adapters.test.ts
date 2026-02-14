import { describe, expect, it } from "bun:test";

import { BraveAdapter } from "../../src/tools/web-search/providers/brave-adapter";
import { ExaAdapter } from "../../src/tools/web-search/providers/exa-adapter";
import {
  mapBraveTextResults,
  mapBraveImageResults,
  mapBraveVideoResults,
  mapBraveNewsResults,
} from "../../src/tools/web-search/providers/brave-mapper";
import {
  mapExaTextResults,
  mapExaNewsResults,
} from "../../src/tools/web-search/providers/exa-mapper";
import {
  supportsSearchType,
  BRAVE_CAPABILITIES,
  EXA_CAPABILITIES,
} from "../../src/tools/web-search/provider-contract";
import type { WebSearchQuery } from "../../src/tools/web-search/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchJson(data: unknown, status = 200): typeof fetch {
  return async () =>
    new Response(JSON.stringify(data), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

// ---------------------------------------------------------------------------
// BraveMapper — direct mapper function tests
// ---------------------------------------------------------------------------

describe("BraveMapper", () => {
  describe("mapBraveTextResults", () => {
    it("maps web results into normalized text items", () => {
      const data = {
        web: {
          results: [
            {
              title: "Example Page",
              url: "https://example.com",
              description: "A description",
              page_age: "2025-01-15",
            },
          ],
        },
      };

      const results = mapBraveTextResults(data);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("text");
      expect(results[0].title).toBe("Example Page");
      expect(results[0].url).toBe("https://example.com");
      expect(results[0].snippet).toBe("A description");
      expect(results[0].publishedAt).toBe("2025-01-15");
    });

    it("returns empty array when web.results is missing", () => {
      const results = mapBraveTextResults({});
      expect(results).toHaveLength(0);
    });

    it("defaults title and url to empty string when missing", () => {
      const data = { web: { results: [{}] } };
      const results = mapBraveTextResults(data);

      expect(results[0].title).toBe("");
      expect(results[0].url).toBe("");
    });
  });

  describe("mapBraveImageResults", () => {
    it("maps image results with thumbnail and properties", () => {
      const data = {
        results: [
          {
            title: "Cat Photo",
            url: "https://images.example.com/cat.jpg",
            thumbnail: { src: "https://thumb.example.com/cat.jpg", width: 150, height: 100 },
            source: "Example Images",
            properties: { url: "https://full.example.com/cat.jpg" },
          },
        ],
      };

      const results = mapBraveImageResults(data);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("image");
      expect(results[0].title).toBe("Cat Photo");
      expect(results[0].imageUrl).toBe("https://full.example.com/cat.jpg");
      expect(results[0].url).toBe("https://full.example.com/cat.jpg");
      expect(results[0].thumbnailUrl).toBe("https://thumb.example.com/cat.jpg");
      expect(results[0].width).toBe(150);
      expect(results[0].height).toBe(100);
      expect(results[0].source).toBe("Example Images");
    });

    it("falls back to url when properties.url is missing", () => {
      const data = {
        results: [
          {
            title: "Fallback",
            url: "https://fallback.example.com/img.jpg",
          },
        ],
      };

      const results = mapBraveImageResults(data);

      expect(results[0].imageUrl).toBe("https://fallback.example.com/img.jpg");
      expect(results[0].url).toBe("https://fallback.example.com/img.jpg");
    });

    it("returns empty array when results is missing", () => {
      const results = mapBraveImageResults({});
      expect(results).toHaveLength(0);
    });
  });

  describe("mapBraveVideoResults", () => {
    it("maps video results with duration and view count", () => {
      const data = {
        results: [
          {
            title: "Tutorial Video",
            url: "https://video.example.com/watch?v=123",
            description: "A tutorial",
            thumbnail: { src: "https://thumb.example.com/123.jpg" },
            video: { duration: "10:30", views: 50000, publisher: "TechChannel" },
            meta_url: { hostname: "video.example.com" },
          },
        ],
      };

      const results = mapBraveVideoResults(data);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("video");
      expect(results[0].title).toBe("Tutorial Video");
      expect(results[0].url).toBe("https://video.example.com/watch?v=123");
      expect(results[0].snippet).toBe("A tutorial");
      expect(results[0].thumbnailUrl).toBe("https://thumb.example.com/123.jpg");
      expect(results[0].duration).toBe("10:30");
      expect(results[0].viewCount).toBe(50000);
      expect(results[0].source).toBe("video.example.com");
    });

    it("falls back to video.publisher when meta_url.hostname is missing", () => {
      const data = {
        results: [
          {
            title: "No Meta",
            url: "https://example.com/v",
            video: { publisher: "FallbackPublisher" },
          },
        ],
      };

      const results = mapBraveVideoResults(data);
      expect(results[0].source).toBe("FallbackPublisher");
    });

    it("returns empty array when results is missing", () => {
      const results = mapBraveVideoResults({});
      expect(results).toHaveLength(0);
    });
  });

  describe("mapBraveNewsResults", () => {
    it("maps news results with source and image", () => {
      const data = {
        results: [
          {
            title: "Breaking News",
            url: "https://news.example.com/article",
            description: "Something happened",
            age: "2 hours ago",
            meta_url: { hostname: "news.example.com" },
            thumbnail: { src: "https://thumb.example.com/news.jpg" },
          },
        ],
      };

      const results = mapBraveNewsResults(data);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("news");
      expect(results[0].title).toBe("Breaking News");
      expect(results[0].url).toBe("https://news.example.com/article");
      expect(results[0].snippet).toBe("Something happened");
      expect(results[0].publishedAt).toBe("2 hours ago");
      expect(results[0].source).toBe("news.example.com");
      expect(results[0].imageUrl).toBe("https://thumb.example.com/news.jpg");
    });

    it("defaults source to empty string when meta_url is missing", () => {
      const data = {
        results: [{ title: "No Source", url: "https://example.com" }],
      };

      const results = mapBraveNewsResults(data);
      expect(results[0].source).toBe("");
    });

    it("returns empty array when results is missing", () => {
      const results = mapBraveNewsResults({});
      expect(results).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// ExaMapper — direct mapper function tests
// ---------------------------------------------------------------------------

describe("ExaMapper", () => {
  describe("mapExaTextResults", () => {
    it("maps text results with highlights and author", () => {
      const data = {
        results: [
          {
            title: "Exa Article",
            url: "https://exa.example.com/article",
            score: 0.95,
            publishedDate: "2025-06-01",
            author: "Jane Doe",
            text: "Full article text content here that is quite long and detailed.",
            highlights: ["Key highlight from the article"],
          },
        ],
      };

      const results = mapExaTextResults(data);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("text");
      expect(results[0].title).toBe("Exa Article");
      expect(results[0].url).toBe("https://exa.example.com/article");
      expect(results[0].score).toBe(0.95);
      expect(results[0].publishedAt).toBe("2025-06-01");
      expect(results[0].author).toBe("Jane Doe");
      expect(results[0].content).toBe("Full article text content here that is quite long and detailed.");
      expect(results[0].snippet).toBe("Key highlight from the article");
    });

    it("falls back to truncated text when highlights are empty", () => {
      const longText = "A".repeat(300);
      const data = {
        results: [
          {
            title: "No Highlights",
            url: "https://example.com",
            text: longText,
            highlights: [],
          },
        ],
      };

      const results = mapExaTextResults(data);

      expect(results[0].snippet).toBe(longText.slice(0, 200));
    });

    it("returns empty array when results is missing", () => {
      const results = mapExaTextResults({});
      expect(results).toHaveLength(0);
    });

    it("defaults title and url to empty string when missing", () => {
      const data = { results: [{}] };
      const results = mapExaTextResults(data);

      expect(results[0].title).toBe("");
      expect(results[0].url).toBe("");
    });
  });

  describe("mapExaNewsResults", () => {
    it("maps news results with source extracted from URL hostname", () => {
      const data = {
        results: [
          {
            title: "Exa News Item",
            url: "https://reuters.com/tech/article-123",
            score: 0.88,
            publishedDate: "2025-07-10",
            text: "News article body text.",
            highlights: ["Important news highlight"],
          },
        ],
      };

      const results = mapExaNewsResults(data);

      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("news");
      expect(results[0].title).toBe("Exa News Item");
      expect(results[0].url).toBe("https://reuters.com/tech/article-123");
      expect(results[0].source).toBe("reuters.com");
      expect(results[0].snippet).toBe("Important news highlight");
      expect(results[0].publishedAt).toBe("2025-07-10");
    });

    it("uses 'unknown' as source when URL is invalid", () => {
      const data = {
        results: [
          { title: "Bad URL", url: "not-a-url" },
        ],
      };

      const results = mapExaNewsResults(data);
      expect(results[0].source).toBe("unknown");
    });

    it("returns empty array when results is missing", () => {
      const results = mapExaNewsResults({});
      expect(results).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// BraveAdapter — integration tests with mock fetchFn
// ---------------------------------------------------------------------------

describe("BraveAdapter", () => {
  const baseQuery: WebSearchQuery = { query: "test query", searchType: "text" };

  describe("text search", () => {
    it("returns normalized text results from Brave API", async () => {
      const apiResponse = {
        web: {
          results: [
            { title: "Result 1", url: "https://r1.com", description: "Desc 1" },
            { title: "Result 2", url: "https://r2.com", description: "Desc 2" },
          ],
          totalEstimatedMatches: 1000,
        },
      };

      const adapter = new BraveAdapter({
        apiKey: "test-key",
        fetchFn: mockFetchJson(apiResponse),
      });

      const result = await adapter.search({ ...baseQuery, searchType: "text" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.provider).toBe("brave");
      expect(result.value.searchType).toBe("text");
      expect(result.value.query).toBe("test query");
      expect(result.value.results).toHaveLength(2);
      expect(result.value.results[0].type).toBe("text");
      expect(result.value.totalResults).toBe(1000);
    });
  });

  describe("image search", () => {
    it("returns normalized image results from Brave API", async () => {
      const apiResponse = {
        results: [
          {
            title: "Image 1",
            url: "https://img.com/1",
            thumbnail: { src: "https://thumb.com/1", width: 200, height: 150 },
            properties: { url: "https://full.com/1" },
            source: "ImageSource",
          },
        ],
      };

      const adapter = new BraveAdapter({
        apiKey: "test-key",
        fetchFn: mockFetchJson(apiResponse),
      });

      const result = await adapter.search({ ...baseQuery, searchType: "image" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.provider).toBe("brave");
      expect(result.value.searchType).toBe("image");
      expect(result.value.results).toHaveLength(1);
      expect(result.value.results[0].type).toBe("image");
    });
  });

  describe("video search", () => {
    it("returns normalized video results from Brave API", async () => {
      const apiResponse = {
        results: [
          {
            title: "Video 1",
            url: "https://vid.com/1",
            description: "A video",
            thumbnail: { src: "https://thumb.com/v1" },
            video: { duration: "5:00", views: 1000 },
            meta_url: { hostname: "vid.com" },
          },
        ],
      };

      const adapter = new BraveAdapter({
        apiKey: "test-key",
        fetchFn: mockFetchJson(apiResponse),
      });

      const result = await adapter.search({ ...baseQuery, searchType: "video" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.provider).toBe("brave");
      expect(result.value.searchType).toBe("video");
      expect(result.value.results).toHaveLength(1);
      expect(result.value.results[0].type).toBe("video");
    });
  });

  describe("news search", () => {
    it("returns normalized news results from Brave API", async () => {
      const apiResponse = {
        results: [
          {
            title: "News 1",
            url: "https://news.com/1",
            description: "Breaking",
            age: "1 hour ago",
            meta_url: { hostname: "news.com" },
            thumbnail: { src: "https://thumb.com/n1" },
          },
        ],
      };

      const adapter = new BraveAdapter({
        apiKey: "test-key",
        fetchFn: mockFetchJson(apiResponse),
      });

      const result = await adapter.search({ ...baseQuery, searchType: "news" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.provider).toBe("brave");
      expect(result.value.searchType).toBe("news");
      expect(result.value.results).toHaveLength(1);
      expect(result.value.results[0].type).toBe("news");
    });
  });

  describe("request parameters", () => {
    it("passes query, count, and offset as URL params for text search", async () => {
      let capturedUrl = "";
      const adapter = new BraveAdapter({
        apiKey: "test-key",
        fetchFn: async (input) => {
          capturedUrl = String(input);
          return new Response(JSON.stringify({ web: { results: [] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      await adapter.search({ query: "bun runtime", searchType: "text", limit: 5, offset: 10 });

      expect(capturedUrl).toContain("q=bun+runtime");
      expect(capturedUrl).toContain("count=5");
      expect(capturedUrl).toContain("offset=10");
    });

    it("sends X-Subscription-Token header", async () => {
      let capturedHeaders: Record<string, string> = {};
      const adapter = new BraveAdapter({
        apiKey: "my-brave-key",
        fetchFn: async (_input, init) => {
          capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
          return new Response(JSON.stringify({ web: { results: [] } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      await adapter.search(baseQuery);

      expect(capturedHeaders["X-Subscription-Token"]).toBe("my-brave-key");
    });
  });
});

// ---------------------------------------------------------------------------
// ExaAdapter — integration tests with mock fetchFn
// ---------------------------------------------------------------------------

describe("ExaAdapter", () => {
  const baseQuery: WebSearchQuery = { query: "test query", searchType: "text" };

  describe("text search", () => {
    it("returns normalized text results from Exa API", async () => {
      const apiResponse = {
        results: [
          {
            title: "Exa Result",
            url: "https://exa.example.com/page",
            score: 0.92,
            publishedDate: "2025-03-01",
            author: "Author Name",
            text: "Full text content",
            highlights: ["Highlighted snippet"],
          },
        ],
      };

      const adapter = new ExaAdapter({
        apiKey: "test-key",
        fetchFn: mockFetchJson(apiResponse),
      });

      const result = await adapter.search({ ...baseQuery, searchType: "text" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.provider).toBe("exa");
      expect(result.value.searchType).toBe("text");
      expect(result.value.query).toBe("test query");
      expect(result.value.results).toHaveLength(1);
      expect(result.value.results[0].type).toBe("text");
    });
  });

  describe("news search", () => {
    it("returns normalized news results from Exa API", async () => {
      const apiResponse = {
        results: [
          {
            title: "News Article",
            url: "https://bbc.com/news/article-1",
            score: 0.85,
            publishedDate: "2025-07-15",
            text: "News body text",
            highlights: ["News highlight"],
          },
        ],
      };

      const adapter = new ExaAdapter({
        apiKey: "test-key",
        fetchFn: mockFetchJson(apiResponse),
      });

      const result = await adapter.search({ ...baseQuery, searchType: "news" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.provider).toBe("exa");
      expect(result.value.searchType).toBe("news");
      expect(result.value.results).toHaveLength(1);
      expect(result.value.results[0].type).toBe("news");
    });

    it("includes category: news in request body", async () => {
      let capturedBody = "";
      const adapter = new ExaAdapter({
        apiKey: "test-key",
        fetchFn: async (_input, init) => {
          capturedBody = init?.body as string ?? "";
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      await adapter.search({ ...baseQuery, searchType: "news" });

      const parsed = JSON.parse(capturedBody);
      expect(parsed.category).toBe("news");
    });
  });

  describe("request parameters", () => {
    it("sends POST request with correct body shape", async () => {
      let capturedMethod = "";
      let capturedBody = "";
      const adapter = new ExaAdapter({
        apiKey: "test-key",
        fetchFn: async (_input, init) => {
          capturedMethod = init?.method ?? "";
          capturedBody = init?.body as string ?? "";
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      await adapter.search({ query: "bun runtime", searchType: "text", limit: 5 });

      expect(capturedMethod).toBe("POST");
      const parsed = JSON.parse(capturedBody);
      expect(parsed.query).toBe("bun runtime");
      expect(parsed.numResults).toBe(5);
      expect(parsed.type).toBe("neural");
      expect(parsed.contents).toEqual({ text: true, highlights: true });
    });

    it("sends x-api-key header", async () => {
      let capturedHeaders: Record<string, string> = {};
      const adapter = new ExaAdapter({
        apiKey: "my-exa-key",
        fetchFn: async (_input, init) => {
          capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      await adapter.search(baseQuery);

      expect(capturedHeaders["x-api-key"]).toBe("my-exa-key");
    });

    it("defaults numResults to 10 when limit is not provided", async () => {
      let capturedBody = "";
      const adapter = new ExaAdapter({
        apiKey: "test-key",
        fetchFn: async (_input, init) => {
          capturedBody = init?.body as string ?? "";
          return new Response(JSON.stringify({ results: [] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });

      await adapter.search({ query: "test", searchType: "text" });

      const parsed = JSON.parse(capturedBody);
      expect(parsed.numResults).toBe(10);
    });
  });

  describe("capability gating", () => {
    it("returns error for image search", async () => {
      const adapter = new ExaAdapter({
        apiKey: "test-key",
        fetchFn: mockFetchJson({}),
      });

      const result = await adapter.search({ query: "cats", searchType: "image" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("does not support search type: image");
    });

    it("returns error for video search", async () => {
      const adapter = new ExaAdapter({
        apiKey: "test-key",
        fetchFn: mockFetchJson({}),
      });

      const result = await adapter.search({ query: "tutorials", searchType: "video" });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("does not support search type: video");
    });
  });
});

// ---------------------------------------------------------------------------
// supportsSearchType — utility function tests
// ---------------------------------------------------------------------------

describe("supportsSearchType", () => {
  it("returns true for all Brave search types", () => {
    expect(supportsSearchType(BRAVE_CAPABILITIES, "text")).toBe(true);
    expect(supportsSearchType(BRAVE_CAPABILITIES, "image")).toBe(true);
    expect(supportsSearchType(BRAVE_CAPABILITIES, "video")).toBe(true);
    expect(supportsSearchType(BRAVE_CAPABILITIES, "news")).toBe(true);
  });

  it("returns true for Exa text and news", () => {
    expect(supportsSearchType(EXA_CAPABILITIES, "text")).toBe(true);
    expect(supportsSearchType(EXA_CAPABILITIES, "news")).toBe(true);
  });

  it("returns false for Exa image and video", () => {
    expect(supportsSearchType(EXA_CAPABILITIES, "image")).toBe(false);
    expect(supportsSearchType(EXA_CAPABILITIES, "video")).toBe(false);
  });
});
