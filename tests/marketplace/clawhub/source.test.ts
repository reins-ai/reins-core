import { describe, expect, it } from "bun:test";

import type {
  ClawHubCategoriesResponse,
  ClawHubDownloadResponse,
  ClawHubSkillDetailResponse,
  ClawHubSkillsResponse,
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
  fetchCategoriesCalls: number;
  enqueueFetchSkills(result: Result<ClawHubSkillsResponse, MarketplaceError>): void;
  enqueueSearchSkills(result: Result<ClawHubSkillsResponse, MarketplaceError>): void;
  enqueueFetchSkillDetail(result: Result<ClawHubSkillDetailResponse, MarketplaceError>): void;
  enqueueDownloadSkill(result: Result<ClawHubDownloadResponse, MarketplaceError>): void;
  enqueueFetchCategories(result: Result<ClawHubCategoriesResponse, MarketplaceError>): void;
}

function createRateLimitedError(): MarketplaceError {
  return new MarketplaceError("rate limited", MARKETPLACE_ERROR_CODES.RATE_LIMITED);
}

function createMockClient(): MockClientControls {
  const fetchSkillsQueue: Array<Result<ClawHubSkillsResponse, MarketplaceError>> = [];
  const searchSkillsQueue: Array<Result<ClawHubSkillsResponse, MarketplaceError>> = [];
  const fetchSkillDetailQueue: Array<Result<ClawHubSkillDetailResponse, MarketplaceError>> = [];
  const downloadSkillQueue: Array<Result<ClawHubDownloadResponse, MarketplaceError>> = [];
  const fetchCategoriesQueue: Array<Result<ClawHubCategoriesResponse, MarketplaceError>> = [];

  const fetchSkillsCalls: FetchSkillsOptions[] = [];
  const searchSkillsCalls: Array<{ query: string; options: SearchSkillsOptions }> = [];
  const fetchSkillDetailCalls: string[] = [];
  const downloadSkillCalls: Array<{ slug: string; version: string }> = [];

  let fetchCategoriesCalls = 0;

  const client: ClawHubClient = {
    async fetchSkills(options: FetchSkillsOptions = {}) {
      fetchSkillsCalls.push(options);
      return fetchSkillsQueue.shift() ?? ok({ skills: [], total: 0, page: 1, pageSize: 20 });
    },
    async searchSkills(query: string, options: SearchSkillsOptions = {}) {
      searchSkillsCalls.push({ query, options });
      return searchSkillsQueue.shift() ?? ok({ skills: [], total: 0, page: 1, pageSize: 20 });
    },
    async fetchSkillDetail(slug: string) {
      fetchSkillDetailCalls.push(slug);
      return fetchSkillDetailQueue.shift() ?? err(new MarketplaceError("missing", MARKETPLACE_ERROR_CODES.NOT_FOUND));
    },
    async downloadSkill(slug: string, version: string) {
      downloadSkillCalls.push({ slug, version });
      return downloadSkillQueue.shift() ?? err(new MarketplaceError("download failed", MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR));
    },
    async fetchCategories() {
      fetchCategoriesCalls += 1;
      return fetchCategoriesQueue.shift() ?? ok({ categories: [] });
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
    get fetchCategoriesCalls() {
      return fetchCategoriesCalls;
    },
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
    enqueueFetchCategories(result) {
      fetchCategoriesQueue.push(result);
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
      skills: [
        {
          slug: "calendar-tool",
          name: "Calendar Tool",
          author: "openclaw",
          description: "Calendar skill",
          installCount: 42,
          trustLevel: "trusted",
          categories: ["productivity"],
          latestVersion: "2.0.0",
          updatedAt: "2026-02-16T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 2,
      pageSize: 10,
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
            author: "openclaw",
            description: "Calendar skill",
            installCount: 42,
            trustLevel: "trusted",
            categories: ["productivity"],
            version: "2.0.0",
            updatedAt: "2026-02-16T00:00:00.000Z",
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
      skills: [
        {
          slug: "agent-memory",
          name: "Agent Memory",
          author: "community",
          description: "Memory helpers",
          installCount: 100,
          trustLevel: "community",
          categories: ["memory"],
          latestVersion: "1.1.0",
          updatedAt: "2026-02-15T00:00:00.000Z",
        },
      ],
      total: 22,
      page: 1,
      pageSize: 20,
    }));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.search("memory", { page: 1, pageSize: 20 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills[0]?.version).toBe("1.1.0");
      expect(result.value.hasMore).toBe(true);
    }
  });

  it("normalizes nested author names and unknown trust levels", async () => {
    const mock = createMockClient();
    mock.enqueueFetchSkills(ok({
      skills: [
        {
          slug: "custom",
          name: "Custom",
          author: { name: "nested-author" } as unknown as string,
          description: "desc",
          installCount: 7,
          trustLevel: "experimental",
          categories: [],
          latestVersion: "0.1.0",
          updatedAt: "2026-02-16T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    }));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.browse();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills[0]?.author).toBe("nested-author");
      expect(result.value.skills[0]?.trustLevel).toBe("untrusted");
    }
  });

  it("getDetail returns normalized MarketplaceSkillDetail", async () => {
    const mock = createMockClient();
    mock.enqueueFetchSkillDetail(ok({
      slug: "planner",
      name: "Planner",
      author: "verified-author",
      description: "Short description",
      installCount: 500,
      trustLevel: "verified",
      categories: ["planning"],
      latestVersion: "3.0.0",
      updatedAt: "2026-02-14T00:00:00.000Z",
      versions: [{ version: "3.0.0" }, { version: "2.0.0" }],
      requiredTools: ["git", "bun"],
      readme: "# Planner",
      homepage: "https://example.com/planner",
      license: "MIT",
    }));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.getDetail("planner");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fullDescription).toBe("# Planner");
      expect(result.value.versions).toEqual(["3.0.0", "2.0.0"]);
      expect(result.value.requiredTools).toEqual(["git", "bun"]);
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

  it("getCategories returns MarketplaceCategory[]", async () => {
    const mock = createMockClient();
    mock.enqueueFetchCategories(ok({
      categories: [{ id: "1", name: "Productivity", slug: "productivity", count: 12 }],
    }));

    const source = new ClawHubSource({ client: mock.client });
    const result = await source.getCategories();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ id: "1", name: "Productivity", slug: "productivity", count: 12 }]);
    }
  });

  it("maps sort modes for browse", async () => {
    const mock = createMockClient();
    mock.enqueueFetchSkills(ok({ skills: [], total: 0, page: 1, pageSize: 20 }));
    mock.enqueueFetchSkills(ok({ skills: [], total: 0, page: 1, pageSize: 20 }));
    mock.enqueueFetchSkills(ok({ skills: [], total: 0, page: 1, pageSize: 20 }));

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
    mock.enqueueFetchSkills(ok({ skills: [], total: 0, page: 1, pageSize: 20 }));

    const source = new ClawHubSource({ client: mock.client });

    await source.browse({ sort: "trending", page: 1, pageSize: 20 });
    await source.browse({ sort: "trending", page: 1, pageSize: 20 });

    expect(mock.fetchSkillsCalls).toHaveLength(1);
  });

  it("rate-limited request falls back to cached data", async () => {
    const mock = createMockClient();
    mock.enqueueSearchSkills(ok({
      skills: [
        {
          slug: "cached-skill",
          name: "Cached Skill",
          author: "author",
          description: "cached",
          installCount: 1,
          trustLevel: "trusted",
          categories: [],
          latestVersion: "1.0.0",
          updatedAt: "2026-02-16T00:00:00.000Z",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
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
