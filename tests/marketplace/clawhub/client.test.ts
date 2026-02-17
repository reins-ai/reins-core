import { describe, expect, it } from "bun:test";

import type {
  ClawHubBrowseResponse,
  ClawHubDetailResponse,
  ClawHubSearchResponse,
} from "../../../src/marketplace/clawhub/api-types";
import { ClawHubClient } from "../../../src/marketplace/clawhub/client";
import { MarketplaceError } from "../../../src/marketplace/errors";

type MockFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function createClient(fetchFn: MockFetch, baseUrl = "https://clawhub.ai"): ClawHubClient {
  return new ClawHubClient({
    baseUrl,
    fetchFn: fetchFn as typeof fetch,
  });
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function withMockedNow<T>(nowMs: number, run: () => Promise<T>): Promise<T> {
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return await run();
  } finally {
    Date.now = originalNow;
  }
}

describe("ClawHubClient", () => {
  it("fetchSkills returns parsed response and sends user agent", async () => {
    const payload: ClawHubBrowseResponse = {
      items: [
        {
          slug: "skill-one",
          displayName: "Skill One",
          summary: "desc",
          tags: { latest: "1.0.0" },
          stats: { installsAllTime: 10 },
          updatedAt: 1_771_288_540_843,
          latestVersion: {
            version: "1.0.0",
            createdAt: 1_767_545_381_030,
            changelog: "",
          },
        },
      ],
      nextCursor: null,
    };

    let requestedUrl = "";
    let userAgent = "";
    const client = createClient(async (input, init) => {
      requestedUrl = String(input);
      userAgent = String((init?.headers as Record<string, string>)?.["User-Agent"]);
      return jsonResponse(payload);
    });

    const result = await client.fetchSkills({ sort: "popular", page: 2, limit: 25, category: "utility" });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(payload);
    }
    expect(requestedUrl).toBe(
      "https://clawhub.ai/api/v1/skills?sort=installsAllTime&page=2&limit=25&category=utility",
    );
    expect(userAgent).toBe("reins/1.0");
  });

  it("searchSkills sends query and returns parsed response", async () => {
    const payload: ClawHubSearchResponse = {
      results: [
        {
          score: 1.2,
          slug: "calendar-tool",
          displayName: "Calendar Tool",
          summary: "calendar skill",
          version: "1.0.0",
          updatedAt: 1_771_287_935_888,
        },
      ],
    };

    let requestedUrl = "";
    const client = createClient(async (input) => {
      requestedUrl = String(input);
      return jsonResponse(payload);
    });

    const result = await client.searchSkills("calendar", { page: 1, limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(payload);
    }
    expect(requestedUrl).toBe("https://clawhub.ai/api/v1/search?q=calendar&limit=10");
  });

  it("fetchSkillDetail returns detail payload", async () => {
    const payload: ClawHubDetailResponse = {
      skill: {
        slug: "skill-one",
        displayName: "Skill One",
        summary: "desc",
        tags: { latest: "2.0.0" },
        stats: {
          installsAllTime: 10,
          installsCurrent: 9,
          comments: 0,
          downloads: 30,
          stars: 2,
          versions: 2,
        },
        createdAt: 1_767_545_381_030,
        updatedAt: 1_771_288_540_843,
      },
      latestVersion: {
        version: "2.0.0",
        createdAt: 1_771_288_540_843,
        changelog: "",
      },
      owner: {
        handle: "author",
        userId: "abc",
        displayName: "Author Name",
        image: "https://example.com/avatar.png",
      },
      moderation: null,
    };

    const client = createClient(async () => jsonResponse(payload));
    const result = await client.fetchSkillDetail("skill-one");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(payload);
    }
  });

  it("downloadSkill returns binary payload metadata", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const client = createClient(async () => {
      return new Response(bytes.buffer, {
        status: 200,
        headers: {
          "content-type": "application/zip",
          "content-disposition": "attachment; filename=skill-one-1.0.0.zip",
        },
      });
    });

    const result = await client.downloadSkill("skill-one", "1.0.0");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.filename).toBe("skill-one-1.0.0.zip");
      expect(result.value.size).toBe(4);
      expect(result.value.contentType).toBe("application/zip");
      expect(new Uint8Array(result.value.data)).toEqual(bytes);
    }
  });

  it("maps 404 responses to MARKETPLACE_NOT_FOUND", async () => {
    const client = createClient(async () => new Response("not found", { status: 404 }));
    const result = await client.fetchSkillDetail("missing");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketplaceError);
      expect(result.error.code).toBe("MARKETPLACE_NOT_FOUND");
    }
  });

  it("maps 429 responses and parses Retry-After plus rate limit info", async () => {
    const client = createClient(async () => {
      return new Response("too many", {
        status: 429,
        headers: {
          "retry-after": "30",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "1760000000",
        },
      });
    });

    const result = await client.fetchSkills();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MARKETPLACE_RATE_LIMITED");
      expect(result.error.message).toContain("Retry after 30 seconds");
    }

    const rateLimitInfo = client.getRateLimitInfo();
    expect(rateLimitInfo.remaining).toBe(0);
    expect(rateLimitInfo.resetAt).toEqual(new Date(1760000000 * 1000));
  });

  it("treats numeric Retry-After epoch seconds as absolute timestamp", async () => {
    const result = await withMockedNow(1_771_314_000_000, async () => {
      const client = createClient(async () => {
        return new Response("too many", {
          status: 429,
          headers: {
            "retry-after": "1771314600",
          },
        });
      });

      return client.fetchSkills();
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MARKETPLACE_RATE_LIMITED");
      expect(result.error.message).toContain("Retry after 600 seconds");
    }
  });

  it("treats numeric Retry-After epoch milliseconds as absolute timestamp", async () => {
    const result = await withMockedNow(1_771_314_000_000, async () => {
      const client = createClient(async () => {
        return new Response("too many", {
          status: 429,
          headers: {
            "retry-after": "1771314600000",
          },
        });
      });

      return client.fetchSkills();
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MARKETPLACE_RATE_LIMITED");
      expect(result.error.message).toContain("Retry after 600 seconds");
    }
  });

  it("maps 500 responses to MARKETPLACE_SOURCE_ERROR", async () => {
    const client = createClient(async () => new Response("server error", { status: 500 }));
    const result = await client.fetchSkills();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MARKETPLACE_SOURCE_ERROR");
    }
  });

  it("maps fetch throw to MARKETPLACE_NETWORK_ERROR", async () => {
    const client = createClient(async () => {
      throw new Error("network down");
    });

    const result = await client.fetchSkills();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MARKETPLACE_NETWORK_ERROR");
    }
  });

  it("maps invalid json payload to MARKETPLACE_INVALID_RESPONSE", async () => {
    const client = createClient(async () => {
      return new Response("{invalid", {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });

    const result = await client.fetchSkills();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MARKETPLACE_INVALID_RESPONSE");
    }
  });
});
