import { describe, expect, it } from "bun:test";

import { TtlCache } from "../../src/marketplace/cache";

describe("TtlCache", () => {
  it("stores and retrieves a value before TTL expires", () => {
    const cache = new TtlCache<string>();

    cache.set("key", "value", 5_000);

    expect(cache.get("key")).toBe("value");
  });

  it("returns undefined for a missing key", () => {
    const cache = new TtlCache<string>();

    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns undefined after TTL expires", async () => {
    const cache = new TtlCache<string>();

    cache.set("key", "value", 50);

    await Bun.sleep(80);

    expect(cache.get("key")).toBeUndefined();
  });

  it("has returns true for a valid entry and false for expired", async () => {
    const cache = new TtlCache<string>();

    cache.set("alive", "yes", 5_000);
    cache.set("dying", "soon", 50);

    expect(cache.has("alive")).toBe(true);
    expect(cache.has("dying")).toBe(true);

    await Bun.sleep(80);

    expect(cache.has("alive")).toBe(true);
    expect(cache.has("dying")).toBe(false);
  });

  it("has returns false for a missing key", () => {
    const cache = new TtlCache<string>();

    expect(cache.has("nope")).toBe(false);
  });

  it("deletes an entry and returns whether it existed", () => {
    const cache = new TtlCache<number>();

    cache.set("a", 1, 5_000);

    expect(cache.delete("a")).toBe(true);
    expect(cache.delete("a")).toBe(false);
    expect(cache.get("a")).toBeUndefined();
  });

  it("clears all entries", () => {
    const cache = new TtlCache<number>();

    cache.set("a", 1, 5_000);
    cache.set("b", 2, 5_000);
    cache.set("c", 3, 5_000);

    cache.clear();

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("c")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("size reflects only non-expired entries", async () => {
    const cache = new TtlCache<string>();

    cache.set("short", "a", 50);
    cache.set("long", "b", 5_000);

    expect(cache.size).toBe(2);

    await Bun.sleep(80);

    expect(cache.size).toBe(1);
  });

  it("overwrites an existing entry with a new value and TTL", async () => {
    const cache = new TtlCache<string>();

    cache.set("key", "old", 50);
    cache.set("key", "new", 5_000);

    await Bun.sleep(80);

    expect(cache.get("key")).toBe("new");
  });

  it("supports different TTLs per entry", async () => {
    const cache = new TtlCache<string>();

    cache.set("fast", "gone-soon", 50);
    cache.set("slow", "stays", 5_000);

    await Bun.sleep(80);

    expect(cache.get("fast")).toBeUndefined();
    expect(cache.get("slow")).toBe("stays");
  });

  it("works with complex value types", () => {
    interface Skill {
      name: string;
      version: string;
    }

    const cache = new TtlCache<Skill>();
    const skill: Skill = { name: "test-skill", version: "1.0.0" };

    cache.set("skill-1", skill, 5_000);

    expect(cache.get("skill-1")).toEqual({ name: "test-skill", version: "1.0.0" });
  });

  it("lazily removes expired entries on get", async () => {
    const cache = new TtlCache<string>();

    cache.set("key", "value", 50);

    await Bun.sleep(80);

    // First get triggers lazy deletion
    expect(cache.get("key")).toBeUndefined();
    // Entry is now removed from internal storage
    expect(cache.has("key")).toBe(false);
  });

  it("lazily removes expired entries on has", async () => {
    const cache = new TtlCache<string>();

    cache.set("key", "value", 50);

    await Bun.sleep(80);

    // has triggers lazy deletion
    expect(cache.has("key")).toBe(false);
    // Confirm it's actually gone
    expect(cache.get("key")).toBeUndefined();
  });
});
