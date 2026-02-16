import { describe, expect, it } from "bun:test";

import { MarketplaceError } from "../../src/marketplace/errors";
import { ReinsMarketplaceSource } from "../../src/marketplace/reins-source";

describe("ReinsMarketplaceSource", () => {
  it("has correct id, name, and description", () => {
    const source = new ReinsMarketplaceSource();

    expect(source.id).toBe("reins");
    expect(source.name).toBe("Reins Marketplace");
    expect(source.description).toBe("Official Reins skill marketplace (Coming Soon)");
  });

  it("browse returns empty results", async () => {
    const source = new ReinsMarketplaceSource();

    const result = await source.browse();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toEqual([]);
      expect(result.value.total).toBe(0);
      expect(result.value.page).toBe(1);
      expect(result.value.pageSize).toBe(20);
      expect(result.value.hasMore).toBe(false);
    }
  });

  it("search returns empty results", async () => {
    const source = new ReinsMarketplaceSource();

    const result = await source.search("anything");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.skills).toEqual([]);
      expect(result.value.total).toBe(0);
      expect(result.value.page).toBe(1);
      expect(result.value.pageSize).toBe(20);
      expect(result.value.hasMore).toBe(false);
    }
  });

  it("getDetail returns not found error", async () => {
    const source = new ReinsMarketplaceSource();

    const result = await source.getDetail("any-slug");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketplaceError);
      expect(result.error.message).toBe("Skill not found");
      expect(result.error.code).toBe("MARKETPLACE_NOT_FOUND");
    }
  });

  it("download returns not available error", async () => {
    const source = new ReinsMarketplaceSource();

    const result = await source.download("any-slug", "1.0.0");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MarketplaceError);
      expect(result.error.message).toBe("Downloads not available");
      expect(result.error.code).toBe("MARKETPLACE_SOURCE_ERROR");
    }
  });

  it("getCategories returns empty array", async () => {
    const source = new ReinsMarketplaceSource();

    const result = await source.getCategories();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });
});
