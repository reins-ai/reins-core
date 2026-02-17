import { describe, expect, it } from "bun:test";

import { MarketplaceError } from "../../src/marketplace/errors";
import { MarketplaceRegistry } from "../../src/marketplace/registry";
import type { MarketplaceSource } from "../../src/marketplace/types";
import { ok } from "../../src/result";

function createSource(overrides: Partial<Pick<MarketplaceSource, "id" | "name" | "description">> = {}): MarketplaceSource {
  return {
    id: overrides.id ?? "test-source",
    name: overrides.name ?? "Test Source",
    description: overrides.description ?? "A test marketplace source",
    async browse() {
      return ok({ skills: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    },
    async search() {
      return ok({ skills: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    },
    async getDetail() {
      return ok({
        slug: "test",
        name: "Test",
        author: "test",
        description: "test",
        installCount: 0,
        trustLevel: "community" as const,
        categories: [],
        version: "1.0.0",
        updatedAt: new Date().toISOString(),
        fullDescription: "test",
        requiredTools: [],
        versions: ["1.0.0"],
      });
    },
    async download() {
      return ok({
        buffer: new Uint8Array(),
        filename: "test.tar.gz",
        size: 0,
        contentType: "application/gzip",
      });
    },
    async getCategories() {
      return ok([]);
    },
  };
}

describe("MarketplaceRegistry", () => {
  it("registers a source and retrieves it by id", () => {
    const registry = new MarketplaceRegistry();
    const source = createSource({ id: "clawhub" });

    registry.register(source);

    expect(registry.get("clawhub")).toBe(source);
  });

  it("lists all registered sources in registration order", () => {
    const registry = new MarketplaceRegistry();
    const first = createSource({ id: "clawhub" });
    const second = createSource({ id: "reins" });

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toEqual([first, second]);
  });

  it("returns undefined for unknown source id", () => {
    const registry = new MarketplaceRegistry();

    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("has returns true for registered source and false for unknown", () => {
    const registry = new MarketplaceRegistry();
    const source = createSource({ id: "clawhub" });

    registry.register(source);

    expect(registry.has("clawhub")).toBe(true);
    expect(registry.has("unknown")).toBe(false);
  });

  it("throws MarketplaceError on duplicate source registration", () => {
    const registry = new MarketplaceRegistry();

    registry.register(createSource({ id: "clawhub" }));

    expect(() => registry.register(createSource({ id: "clawhub" }))).toThrow(MarketplaceError);
  });

  it("normalizes source ids for register, get, has, and remove", () => {
    const registry = new MarketplaceRegistry();
    const source = createSource({ id: "  ClawHub  " });

    registry.register(source);

    expect(registry.get("clawhub")).toBe(source);
    expect(registry.get(" CLAWHUB ")).toBe(source);
    expect(registry.has(" ClawHub")).toBe(true);
    expect(registry.remove(" clawhub ")).toBe(true);
    expect(registry.has("clawhub")).toBe(false);
  });

  it("removes a source and returns whether it existed", () => {
    const registry = new MarketplaceRegistry();
    registry.register(createSource({ id: "temporary" }));

    expect(registry.remove("temporary")).toBe(true);
    expect(registry.remove("temporary")).toBe(false);
    expect(registry.has("temporary")).toBe(false);
  });

  it("clears all sources", () => {
    const registry = new MarketplaceRegistry();
    registry.register(createSource({ id: "clawhub" }));
    registry.register(createSource({ id: "reins" }));

    registry.clear();

    expect(registry.list()).toHaveLength(0);
    expect(registry.has("clawhub")).toBe(false);
    expect(registry.has("reins")).toBe(false);
  });
});
