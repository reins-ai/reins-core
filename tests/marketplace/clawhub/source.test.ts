import { describe, expect, it } from "bun:test";

import type {
  ClawHubBrowseResponse,
  ClawHubDetailResponse,
  ClawHubDownloadResponse,
  ClawHubSearchResponse,
} from "../../../src/marketplace/clawhub/api-types";
import type { ClawHubClient, FetchSkillsOptions, SearchSkillsOptions } from "../../../src/marketplace/clawhub/client";
import { ClawHubSource } from "../../../src/marketplace/clawhub/source";
import { MARKETPLACE_ERROR_CODES, MarketplaceError } from "../../../src/marketplace/errors";
import type { Result } from "../../../src/result";
import { err, ok } from "../../../src/result";

interface MockClientControls {
  client: ClawHubClient;
  fetchSkillsCalls: FetchSkillsOptions[];
  searchSkillsCalls: Array<{ query: string; options: SearchSkillsOptions }>;
  fetchSkillDetailCalls: string[];
  downloadSkillCalls: Array<{ slug: string; version: string }>;
  enqueueFetchSkills(result: Result<ClawHubBrowseResponse, MarketplaceError>): void;
  enqueueSearchSkills(result: Result<ClawHubSearchResponse, MarketplaceError>): void;
  enqueueFetchSkillDetail(result: Result<ClawHubDetailResponse, MarketplaceError>): void;
  enqueueDownloadSkill(result: Result<ClawHubDownloadResponse, MarketplaceError>): void;
}

function createRateLimitedError(): MarketplaceError {
  return new MarketplaceError("rate limited", MARKETPLACE_ERROR_CODES.RATE_LIMITED);
}

function createMockClient(): MockClientControls {
  const fetchSkillsQueue: Array<Result<ClawHubBrowseResponse, MarketplaceError>> = [];
  const searchSkillsQueue: Array<Result<ClawHubSearchResponse, MarketplaceError>> = [];
  const fetchSkillDetailQueue: Array<Result<ClawHubDetailResponse, MarketplaceError>> = [];
  const downloadSkillQueue: Array<Result<ClawHubDownloadResponse, MarketplaceError>> = [];

  const fetchSkillsCalls: FetchSkillsOptions[] = [];
  const searchSkillsCalls: Array<{ query: string; options: SearchSkillsOptions }> = [];
  const fetchSkillDetailCalls: string[] = [];
  const downloadSkillCalls: Array<{ slug: string; version: string }> = [];

  const client: ClawHubClient = {
    async fetchSkills(options: FetchSkillsOptions = {}) {
      fetchSkillsCalls.push(options);
      return fetchSkillsQueue.shift() ?? ok({ items: [], nextCursor: null });
    },
    async searchSkills(query: string, options: SearchSkillsOptions = {}) {
      searchSkillsCalls.push({ query, options });
      return searchSkillsQueue.shift() ?? ok({ results: [] });
    },
    async fetchSkillDetail(slug: string) {
      fetchSkillDetailCalls.push(slug);
      return fetchSkillDetailQueue.shift() ?? err(new MarketplaceError("missing", MARKETPLACE_ERROR_CODES.NOT_FOUND));
    },
    async downloadSkill(slug: string, version: string) {
      downloadSkillCalls.push({ slug, version });
      return downloadSkillQueue.shift() ?? err(new MarketplaceError("download failed", MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR));
    },
    getRateLimitInfo() {
      return { remaining: null, resetAt: null };
    },
  } as ClawHubClient;

  return {
    client,
    fetchSkillsCalls,
    searchSkillsCalls,
    fetchSkillDetailCalls,
    downloadSkillCalls,
    enqueueFetchSkills(result) {
      fetchSkillsQueue.push(result);
    },
    enqueueSearchSkills(result) {
      searchSkillsQueue.push(result);
    },
    enqueueFetchSkillDetail(result) {
      fetchSkillDetailQueue.push(result);
    },
    enqueueDownloadSkill(result) {
      downloadSkillQueue.push(result);
    },
  };
}

async function withMockedNow<T>(initial: number, run: (advanceTo: (next: number) => void) => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  let now = initial;
  Date.now = () => now;

  try {
    return await run((next) => {
      now = next;
    });
  } finally {
    Date.now = originalNow;
  }
}

describe("ClawHubSource", () => {
  it("browse returns normalized MarketplaceSearchResult", async () => {
    const mock = createMockClient();
    mock.enqueueFetchSkills(ok({
      items: [
        {
          slug: "calendar-tool",
          displayName: "Calendar Tool",
          summary: "Calendar skill",
          tags: { latest: "2.0.0" },
          stats: { installsAllTime: 42 },
          updatedAt: 1_771_292_800_000,
        },
      ],
      nextCursor: null,
    }));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.browse({ sort: "popular", page: 2, pageSize: 10, category: "productivity" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        skills: [
          {
            slug: "calendar-tool",
            name: "Calendar Tool",
            author: "unknown",
            description: "Calendar skill",
            installCount: 42,
            trustLevel: "community",
            categories: [],
            version: "2.0.0",
            updatedAt: "2026-02-17T01:46:40.000Z",
          },
        ],
        total: 1,
        page: 2,
        pageSize: 10,
        hasMore: false,
      });
    }
  });

  it("search returns normalized results", async () => {
    const mock = createMockClient();
    mock.enqueueSearchSkills(ok({
      results: [
        {
          slug: "agent-memory",
          displayName: "Agent Memory",
          summary: "Memory helpers",
          version: "1.1.0",
          updatedAt: 1_771_206_400_000,
        },
      ],
    }));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.search("memory", { page: 1, pageSize: 20 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills[0]?.version).toBe("1.1.0");
      expect(result.value.hasMore).toBe(false);
    }
  });

  it("normalizes missing browse fields with defensive defaults", async () => {
    const mock = createMockClient();
    mock.enqueueFetchSkills(ok({
      items: [
        {
          slug: "custom",
          displayName: "",
        },
      ],
      nextCursor: null,
    }));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.browse();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills[0]?.name).toBe("custom");
      expect(result.value.skills[0]?.author).toBe("unknown");
      expect(result.value.skills[0]?.trustLevel).toBe("community");
      expect(result.value.skills[0]?.version).toBe("unknown");
    }
  });

  it("getDetail returns normalized MarketplaceSkillDetail", async () => {
    const mock = createMockClient();
    mock.enqueueFetchSkillDetail(ok({
      skill: {
        slug: "planner",
        displayName: "Planner",
        summary: "Short description",
        tags: { latest: "3.0.0" },
        stats: { installsAllTime: 500 },
        updatedAt: 1_771_120_000_000,
      },
      latestVersion: { version: "3.0.0", createdAt: 1_771_120_000_000, changelog: "" },
      owner: { handle: "verified-author", displayName: "Verified Author" },
      moderation: null,
    }));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.getDetail("planner");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.author).toBe("Verified Author");
      expect(result.value.fullDescription).toBe("Short description");
      expect(result.value.versions).toEqual(["3.0.0"]);
      expect(result.value.requiredTools).toEqual([]);
    }
  });

  it("download returns DownloadResult", async () => {
    const mock = createMockClient();
    const payload = new Uint8Array([1, 2, 3]).buffer;

    mock.enqueueDownloadSkill(ok({
      data: payload,
      filename: "planner-1.0.0.zip",
      size: 3,
      contentType: "application/zip",
    }));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.download("planner", "1.0.0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        buffer: payload,
        filename: "planner-1.0.0.zip",
        size: 3,
        contentType: "application/zip",
      });
    }
  });

  it("getCategories returns empty list without API call", async () => {
    const mock = createMockClient();
    const source = new ClawHubSource({ client: mock.client });
    const result = await source.getCategories();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
    expect(mock.fetchSkillsCalls).toHaveLength(0);
    expect(mock.searchSkillsCalls).toHaveLength(0);
  });

  it("maps sort modes for browse", async () => {
    const mock = createMockClient();
    mock.enqueueFetchSkills(ok({ items: [], nextCursor: null }));
    mock.enqueueFetchSkills(ok({ items: [], nextCursor: null }));
    mock.enqueueFetchSkills(ok({ items: [], nextCursor: null }));

    const source = new ClawHubSource({ client: mock.client });
    await source.browse({ sort: "trending" });
    await source.browse({ sort: "popular" });
    await source.browse({ sort: "recent" });

    expect(mock.fetchSkillsCalls).toEqual([
      { sort: "trending", page: 1, limit: 20, category: undefined },
      { sort: "popular", page: 1, limit: 20, category: undefined },
      { sort: "recent", page: 1, limit: 20, category: undefined },
    ]);
  });

  it("cache hit returns cached data and skips client call", async () => {
    const mock = createMockClient();
    mock.enqueueFetchSkills(ok({ items: [], nextCursor: null }));

    const source = new ClawHubSource({ client: mock.client });

    await source.browse({ sort: "trending", page: 1, pageSize: 20 });
    await source.browse({ sort: "trending", page: 1, pageSize: 20 });

    expect(mock.fetchSkillsCalls).toHaveLength(1);
  });

  it("rate-limited request falls back to cached data", async () => {
    const mock = createMockClient();
    mock.enqueueSearchSkills(ok({
      results: [
        {
          slug: "cached-skill",
          displayName: "Cached Skill",
          summary: "cached",
          version: "1.0.0",
          updatedAt: 1_771_292_800_000,
        },
      ],
    }));
    mock.enqueueSearchSkills(err(createRateLimitedError()));

    const source = new ClawHubSource({ client: mock.client });

    await withMockedNow(1_000, async (advanceTo) => {
      const first = await source.search("cacheable", { page: 1, pageSize: 20 });
      expect(first.ok).toBe(true);

      advanceTo(200_000);

      const second = await source.search("cacheable", { page: 1, pageSize: 20 });
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.value.skills[0]?.slug).toBe("cached-skill");
      }
    });

    expect(mock.searchSkillsCalls).toHaveLength(2);
  });

  it("rate-limited request with no cache returns error", async () => {
    const mock = createMockClient();
    mock.enqueueFetchSkillDetail(err(createRateLimitedError()));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.getDetail("no-cache");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketplaceError);
      expect(result.error.code).toBe(MARKETPLACE_ERROR_CODES.RATE_LIMITED);
    }
  });
});
