import { beforeEach, describe, expect, it } from "bun:test";

import type {
  ClawHubCategoriesResponse,
  ClawHubSkillDetailResponse,
  ClawHubSkillsResponse,
} from "../../../src/marketplace/clawhub/api-types";
import { ClawHubSource } from "../../../src/marketplace/clawhub/source";
import { MARKETPLACE_ERROR_CODES } from "../../../src/marketplace/errors";
import {
  mockClawHubCategoriesResponse,
  mockClawHubDetailResponse,
  mockClawHubSearchResponse,
  mockClawHubSkillsResponse,
} from "./fixtures";

type FetchCall = { url: string; init: RequestInit | undefined };

interface MockFetchContext {
  calls: FetchCall[];
  enqueue(response: Response): void;
  fetchFn: typeof fetch;
}

function createMockFetch(): MockFetchContext {
  const calls: FetchCall[] = [];
  const queue: Response[] = [];

  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    const next = queue.shift();
    if (!next) {
      throw new Error(`No mock response queued for call #${calls.length}: ${String(input)}`);
    }
    return next;
  }) as typeof fetch;

  return {
    calls,
    enqueue(response: Response) {
      queue.push(response);
    },
    fetchFn,
  };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers as Record<string, string> ?? {}),
    },
  });
}

function createSource(fetchFn: typeof fetch): ClawHubSource {
  return new ClawHubSource({
    baseUrl: "https://clawhub.ai",
    fetchFn,
  });
}

/**
 * Run a callback with Date.now() mocked to a controlled value.
 * Allows advancing time to test cache expiration.
 */
async function withMockedNow<T>(
  initial: number,
  run: (advanceTo: (next: number) => void) => Promise<T>,
): Promise<T> {
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

describe("ClawHub Integration", () => {
  let mock: MockFetchContext;
  let source: ClawHubSource;

  beforeEach(() => {
    mock = createMockFetch();
    source = createSource(mock.fetchFn);
  });

  describe("browse → cache pipeline", () => {
    it("first browse hits API, second returns from cache", async () => {
      mock.enqueue(jsonResponse(mockClawHubSkillsResponse));

      const first = await source.browse({ sort: "trending" });
      const second = await source.browse({ sort: "trending" });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      if (first.ok && second.ok) {
        expect(first.value.skills).toHaveLength(3);
        expect(second.value).toEqual(first.value);
      }

      expect(mock.calls).toHaveLength(1);
    });

    it("different sort modes produce separate cache entries", async () => {
      mock.enqueue(jsonResponse(mockClawHubSkillsResponse));
      mock.enqueue(jsonResponse({ ...mockClawHubSkillsResponse, page: 1 }));

      await source.browse({ sort: "trending" });
      await source.browse({ sort: "popular" });

      expect(mock.calls).toHaveLength(2);
    });
  });

  describe("search → cache pipeline", () => {
    it("different queries both hit API (no shared cache)", async () => {
      mock.enqueue(jsonResponse(mockClawHubSearchResponse));
      mock.enqueue(jsonResponse({
        skills: [],
        total: 0,
        page: 1,
        pageSize: 20,
      } satisfies ClawHubSkillsResponse));

      const first = await source.search("calendar");
      const second = await source.search("nonexistent");

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      if (first.ok) {
        expect(first.value.skills).toHaveLength(2);
        expect(first.value.skills[0]?.slug).toBe("smart-calendar-sync");
      }
      if (second.ok) {
        expect(second.value.skills).toHaveLength(0);
      }

      expect(mock.calls).toHaveLength(2);
    });

    it("same query returns cached result on second call", async () => {
      mock.enqueue(jsonResponse(mockClawHubSearchResponse));

      await source.search("calendar");
      await source.search("calendar");

      expect(mock.calls).toHaveLength(1);
    });
  });

  describe("detail fetch", () => {
    it("fetches and normalizes a skill detail", async () => {
      mock.enqueue(jsonResponse(mockClawHubDetailResponse));

      const result = await source.getDetail("smart-calendar-sync");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.slug).toBe("smart-calendar-sync");
        expect(result.value.name).toBe("Smart Calendar Sync");
        expect(result.value.author).toBe("openclaw");
        expect(result.value.version).toBe("2.4.1");
        expect(result.value.trustLevel).toBe("verified");
        expect(result.value.fullDescription).toContain("seamless bidirectional synchronization");
        expect(result.value.versions).toEqual(["2.4.1", "2.4.0", "2.3.0"]);
        expect(result.value.requiredTools).toEqual(["curl", "jq"]);
        expect(result.value.homepage).toBe("https://github.com/openclaw/smart-calendar-sync");
        expect(result.value.license).toBe("MIT");
        expect(result.value.readme).toContain("# Smart Calendar Sync");
      }
    });

    it("caches detail on second fetch for same slug", async () => {
      mock.enqueue(jsonResponse(mockClawHubDetailResponse));

      await source.getDetail("smart-calendar-sync");
      await source.getDetail("smart-calendar-sync");

      expect(mock.calls).toHaveLength(1);
    });
  });

  describe("categories", () => {
    it("fetches and normalizes categories", async () => {
      mock.enqueue(jsonResponse(mockClawHubCategoriesResponse));

      const result = await source.getCategories();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(5);
        expect(result.value[0]).toEqual({
          id: "cat-prod",
          name: "Productivity",
          slug: "productivity",
          count: 42,
        });
        expect(result.value[4]).toEqual({
          id: "cat-cal",
          name: "Calendar",
          slug: "calendar",
          count: 11,
        });
      }
    });

    it("caches categories on second fetch", async () => {
      mock.enqueue(jsonResponse(mockClawHubCategoriesResponse));

      await source.getCategories();
      await source.getCategories();

      expect(mock.calls).toHaveLength(1);
    });
  });

  describe("rate-limit fallback", () => {
    it("returns cached data when rate-limited after successful browse", async () => {
      await withMockedNow(1_000, async (advanceTo) => {
        mock.enqueue(jsonResponse(mockClawHubSkillsResponse));
        mock.enqueue(new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "60" },
        }));

        const first = await source.browse({ sort: "trending" });
        expect(first.ok).toBe(true);

        // Advance past the 5min browse TTL so the live cache expires
        // but the stale fallback cache still has data
        advanceTo(400_000);

        const second = await source.browse({ sort: "trending" });
        expect(second.ok).toBe(true);

        if (first.ok && second.ok) {
          expect(second.value.skills).toHaveLength(3);
          expect(second.value).toEqual(first.value);
        }

        expect(mock.calls).toHaveLength(2);
      });
    });

    it("returns error when rate-limited with no cached data", async () => {
      mock.enqueue(new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "30" },
      }));

      const result = await source.browse({ sort: "trending" });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(MARKETPLACE_ERROR_CODES.RATE_LIMITED);
      }
    });

    it("returns cached search data when rate-limited after successful search", async () => {
      await withMockedNow(1_000, async (advanceTo) => {
        mock.enqueue(jsonResponse(mockClawHubSearchResponse));
        mock.enqueue(new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "60" },
        }));

        const first = await source.search("calendar");
        expect(first.ok).toBe(true);

        // Advance past the 2min search TTL
        advanceTo(200_000);

        const second = await source.search("calendar");
        expect(second.ok).toBe(true);

        if (second.ok) {
          expect(second.value.skills[0]?.slug).toBe("smart-calendar-sync");
        }

        expect(mock.calls).toHaveLength(2);
      });
    });

    it("returns cached detail when rate-limited after successful detail fetch", async () => {
      await withMockedNow(1_000, async (advanceTo) => {
        mock.enqueue(jsonResponse(mockClawHubDetailResponse));
        mock.enqueue(new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "60" },
        }));

        const first = await source.getDetail("smart-calendar-sync");
        expect(first.ok).toBe(true);

        // Advance past the 15min detail TTL
        advanceTo(1_000_000);

        const second = await source.getDetail("smart-calendar-sync");
        expect(second.ok).toBe(true);

        if (second.ok) {
          expect(second.value.slug).toBe("smart-calendar-sync");
        }

        expect(mock.calls).toHaveLength(2);
      });
    });

    it("returns cached categories when rate-limited after successful fetch", async () => {
      await withMockedNow(1_000, async (advanceTo) => {
        mock.enqueue(jsonResponse(mockClawHubCategoriesResponse));
        mock.enqueue(new Response("Too Many Requests", {
          status: 429,
          headers: { "retry-after": "60" },
        }));

        const first = await source.getCategories();
        expect(first.ok).toBe(true);

        // Advance past the 1hr categories TTL
        advanceTo(4_000_000);

        const second = await source.getCategories();
        expect(second.ok).toBe(true);

        if (second.ok) {
          expect(second.value).toHaveLength(5);
        }

        expect(mock.calls).toHaveLength(2);
      });
    });
  });

  describe("error propagation", () => {
    it("network error propagates as MARKETPLACE_NETWORK_ERROR", async () => {
      const failingFetch = (async () => {
        throw new Error("DNS resolution failed");
      }) as typeof fetch;

      const failSource = createSource(failingFetch);
      const result = await failSource.browse();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(MARKETPLACE_ERROR_CODES.NETWORK_ERROR);
      }
    });

    it("404 response propagates as MARKETPLACE_NOT_FOUND", async () => {
      mock.enqueue(new Response("Not Found", { status: 404 }));

      const result = await source.getDetail("nonexistent-skill");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(MARKETPLACE_ERROR_CODES.NOT_FOUND);
      }
    });

    it("500 response propagates as MARKETPLACE_SOURCE_ERROR", async () => {
      mock.enqueue(new Response("Internal Server Error", { status: 500 }));

      const result = await source.browse();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(MARKETPLACE_ERROR_CODES.SOURCE_ERROR);
      }
    });

    it("network error on search propagates correctly", async () => {
      const failingFetch = (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch;

      const failSource = createSource(failingFetch);
      const result = await failSource.search("anything");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(MARKETPLACE_ERROR_CODES.NETWORK_ERROR);
      }
    });

    it("500 on categories propagates as MARKETPLACE_SOURCE_ERROR", async () => {
      mock.enqueue(new Response("Service Unavailable", { status: 503 }));

      const result = await source.getCategories();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe(MARKETPLACE_ERROR_CODES.SOURCE_ERROR);
      }
    });
  });

  describe("normalization through full pipeline", () => {
    it("normalizes latestVersion to version in browse results", async () => {
      mock.enqueue(jsonResponse(mockClawHubSkillsResponse));

      const result = await source.browse();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skills[0]?.version).toBe("2.4.1");
        expect(result.value.skills[1]?.version).toBe("1.8.0");
        expect(result.value.skills[2]?.version).toBe("0.9.3");
      }
    });

    it("computes hasMore correctly based on pagination", async () => {
      mock.enqueue(jsonResponse(mockClawHubSkillsResponse));

      const result = await source.browse();

      expect(result.ok).toBe(true);
      if (result.ok) {
        // total=147, page=1, pageSize=20 → 1*20=20 < 147 → hasMore=true
        expect(result.value.hasMore).toBe(true);
      }
    });

    it("normalizes detail versions array to version strings", async () => {
      mock.enqueue(jsonResponse(mockClawHubDetailResponse));

      const result = await source.getDetail("smart-calendar-sync");

      expect(result.ok).toBe(true);
      if (result.ok) {
        // ClawHub returns { version, publishedAt, changelog } objects
        // Source normalizes to plain version strings
        expect(result.value.versions).toEqual(["2.4.1", "2.4.0", "2.3.0"]);
      }
    });

    it("uses fullDescription over readme for detail fullDescription field", async () => {
      mock.enqueue(jsonResponse(mockClawHubDetailResponse));

      const result = await source.getDetail("smart-calendar-sync");

      expect(result.ok).toBe(true);
      if (result.ok) {
        // fullDescription is present, so it should be used over readme
        expect(result.value.fullDescription).toBe(mockClawHubDetailResponse.fullDescription);
      }
    });

    it("falls back to readme when fullDescription is absent", async () => {
      const detailWithoutFullDesc: ClawHubSkillDetailResponse = {
        ...mockClawHubDetailResponse,
        fullDescription: undefined,
      };
      mock.enqueue(jsonResponse(detailWithoutFullDesc));

      const result = await source.getDetail("smart-calendar-sync");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fullDescription).toBe(mockClawHubDetailResponse.readme);
      }
    });

    it("falls back to description when both fullDescription and readme are absent", async () => {
      const detailMinimal: ClawHubSkillDetailResponse = {
        ...mockClawHubDetailResponse,
        fullDescription: undefined,
        readme: undefined,
      };
      mock.enqueue(jsonResponse(detailMinimal));

      const result = await source.getDetail("smart-calendar-sync");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.fullDescription).toBe(mockClawHubDetailResponse.description);
      }
    });

    it("preserves trust levels through the pipeline", async () => {
      mock.enqueue(jsonResponse(mockClawHubSkillsResponse));

      const result = await source.browse();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.skills[0]?.trustLevel).toBe("verified");
        expect(result.value.skills[1]?.trustLevel).toBe("trusted");
        expect(result.value.skills[2]?.trustLevel).toBe("community");
      }
    });
  });
});
