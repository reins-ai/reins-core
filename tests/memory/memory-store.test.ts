import { describe, expect, test } from "bun:test";

import { InMemoryMemoryStore } from "../../src/memory/memory-store";
import type { MemoryEntry } from "../../src/memory/types";

function createInput(overrides?: Partial<Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">>) {
  return {
    content: overrides?.content ?? "Default memory",
    type: overrides?.type ?? "note",
    tags: overrides?.tags ?? ["general"],
    importance: overrides?.importance ?? 0.5,
    conversationId: overrides?.conversationId,
    expiresAt: overrides?.expiresAt,
  } satisfies Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">;
}

describe("InMemoryMemoryStore", () => {
  test("saves and retrieves memory entries", async () => {
    const store = new InMemoryMemoryStore();
    const saved = await store.save(createInput({ content: "Likes green tea", type: "preference" }));

    const loaded = await store.get(saved.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.content).toBe("Likes green tea");
    expect(loaded?.type).toBe("preference");
    expect(loaded?.createdAt).toBeInstanceOf(Date);
    expect(loaded?.updatedAt).toBeInstanceOf(Date);
  });

  test("searches by query text", async () => {
    const store = new InMemoryMemoryStore();
    await store.save(createInput({ content: "User prefers concise responses" }));
    await store.save(createInput({ content: "Weather is cloudy" }));

    const results = await store.search({ query: "concise" });
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.content).toContain("concise");
  });

  test("searches by tags with any-match behavior", async () => {
    const store = new InMemoryMemoryStore();
    await store.save(createInput({ content: "Prefers markdown", tags: ["format", "markdown"] }));
    await store.save(createInput({ content: "Timezone PST", tags: ["timezone"] }));

    const results = await store.search({ tags: ["timezone", "memory"] });
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.tags).toContain("timezone");
  });

  test("searches by type", async () => {
    const store = new InMemoryMemoryStore();
    await store.save(createInput({ type: "fact", content: "Name is Jordan" }));
    await store.save(createInput({ type: "note", content: "Temporary thought" }));

    const results = await store.search({ type: "fact" });
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.type).toBe("fact");
  });

  test("searches by minimum importance", async () => {
    const store = new InMemoryMemoryStore();
    await store.save(createInput({ content: "Low importance", importance: 0.2 }));
    await store.save(createInput({ content: "High importance", importance: 0.9 }));

    const results = await store.search({ minImportance: 0.7 });
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.content).toBe("High importance");
  });

  test("excludes expired entries by default", async () => {
    const store = new InMemoryMemoryStore();
    await store.save(
      createInput({
        content: "Expired context",
        expiresAt: new Date(Date.now() - 60_000),
      }),
    );
    await store.save(
      createInput({
        content: "Active context",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );

    const defaultResults = await store.search({});
    expect(defaultResults).toHaveLength(1);
    expect(defaultResults[0]?.entry.content).toBe("Active context");

    const includeExpired = await store.search({ includeExpired: true });
    expect(includeExpired).toHaveLength(2);
  });

  test("updates entry fields", async () => {
    const store = new InMemoryMemoryStore();
    const saved = await store.save(createInput({ content: "Old", tags: ["a"], importance: 0.1 }));

    const updated = await store.update(saved.id, {
      content: "New",
      tags: ["updated", "a"],
      importance: 0.8,
    });

    expect(updated).not.toBeNull();
    expect(updated?.content).toBe("New");
    expect(updated?.tags).toEqual(["updated", "a"]);
    expect(updated?.importance).toBe(0.8);
    expect((updated?.updatedAt.getTime() ?? 0) >= saved.updatedAt.getTime()).toBe(true);
  });

  test("deletes entries by id", async () => {
    const store = new InMemoryMemoryStore();
    const saved = await store.save(createInput());

    expect(await store.delete(saved.id)).toBe(true);
    expect(await store.delete(saved.id)).toBe(false);
    expect(await store.get(saved.id)).toBeNull();
  });

  test("deletes entries by conversation id", async () => {
    const store = new InMemoryMemoryStore();
    await store.save(createInput({ conversationId: "conv-1" }));
    await store.save(createInput({ conversationId: "conv-1" }));
    await store.save(createInput({ conversationId: "conv-2" }));

    const count = await store.deleteByConversation("conv-1");
    expect(count).toBe(2);

    const results = await store.search({ includeExpired: true });
    expect(results).toHaveLength(1);
    expect(results[0]?.entry.conversationId).toBe("conv-2");
  });

  test("clears all entries", async () => {
    const store = new InMemoryMemoryStore();
    await store.save(createInput());
    await store.save(createInput());

    await store.clear();
    expect((await store.search({ includeExpired: true })).length).toBe(0);
  });

  test("returns deep-cloned entries to prevent mutation", async () => {
    const store = new InMemoryMemoryStore();
    const saved = await store.save(createInput({ tags: ["one"], content: "Immutable" }));

    saved.tags.push("mutated");
    const loaded = await store.get(saved.id);
    expect(loaded?.tags).toEqual(["one"]);

    if (!loaded) {
      throw new Error("Expected entry to load");
    }

    loaded.content = "Changed outside";
    const loadedAgain = await store.get(saved.id);
    expect(loadedAgain?.content).toBe("Immutable");

    const searchResults = await store.search({ query: "immutable" });
    searchResults[0]?.entry.tags.push("from-search");
    const afterSearchMutation = await store.get(saved.id);
    expect(afterSearchMutation?.tags).toEqual(["one"]);
  });
});
