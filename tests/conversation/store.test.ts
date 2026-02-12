import { describe, expect, test } from "bun:test";

import { InMemoryConversationStore } from "../../src/conversation/memory-store";
import type { Conversation } from "../../src/types";

function createConversation(overrides?: Partial<Conversation>): Conversation {
  const createdAt = overrides?.createdAt ?? new Date("2026-01-01T00:00:00.000Z");
  const updatedAt = overrides?.updatedAt ?? new Date("2026-01-01T00:00:00.000Z");

  return {
    id: overrides?.id ?? "conv-1",
    title: overrides?.title ?? "Conversation 1",
    messages: overrides?.messages ?? [],
    model: overrides?.model ?? "gpt-4o-mini",
    provider: overrides?.provider ?? "openai",
    personaId: overrides?.personaId,
    workspaceId: overrides?.workspaceId,
    createdAt,
    updatedAt,
    metadata: overrides?.metadata,
  };
}

describe("InMemoryConversationStore", () => {
  test("saves, loads, checks existence, and deletes conversations", async () => {
    const store = new InMemoryConversationStore();
    const conversation = createConversation({ id: "conv-basic" });

    await store.save(conversation);

    expect(await store.exists("conv-basic")).toBe(true);
    expect(await store.exists("missing")).toBe(false);

    const loaded = await store.load("conv-basic");
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe("conv-basic");

    expect(await store.delete("conv-basic")).toBe(true);
    expect(await store.delete("conv-basic")).toBe(false);
    expect(await store.load("conv-basic")).toBeNull();
  });

  test("deep-clones on save and load", async () => {
    const store = new InMemoryConversationStore();
    const original = createConversation({
      id: "conv-clone",
      messages: [
        {
          id: "msg-1",
          role: "user",
          content: "hello",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          metadata: { source: "user-input" },
        },
      ],
    });

    await store.save(original);

    original.title = "mutated-after-save";
    original.messages[0]!.content = "changed";

    const loaded = await store.load("conv-clone");
    expect(loaded).not.toBeNull();
    expect(loaded?.title).toBe("Conversation 1");
    expect(loaded?.messages[0]?.content).toBe("hello");

    if (!loaded) {
      throw new Error("Expected conversation to load");
    }

    loaded.messages[0]!.content = "mutated-loaded";
    const loadedAgain = await store.load("conv-clone");
    expect(loadedAgain?.messages[0]?.content).toBe("hello");
  });

  test("lists with workspace filtering and pagination", async () => {
    const store = new InMemoryConversationStore();

    await store.save(
      createConversation({
        id: "conv-a",
        title: "A",
        workspaceId: "ws-1",
        updatedAt: new Date("2026-01-01T01:00:00.000Z"),
      }),
    );
    await store.save(
      createConversation({
        id: "conv-b",
        title: "B",
        workspaceId: "ws-1",
        updatedAt: new Date("2026-01-01T03:00:00.000Z"),
      }),
    );
    await store.save(
      createConversation({
        id: "conv-c",
        title: "C",
        workspaceId: "ws-2",
        updatedAt: new Date("2026-01-01T02:00:00.000Z"),
      }),
    );

    const ws1 = await store.list({ workspaceId: "ws-1" });
    expect(ws1.map((item) => item.id)).toEqual(["conv-b", "conv-a"]);

    const paged = await store.list({ workspaceId: "ws-1", offset: 1, limit: 1 });
    expect(paged).toHaveLength(1);
    expect(paged[0]?.id).toBe("conv-a");
  });

  test("supports list ordering by created and updated", async () => {
    const store = new InMemoryConversationStore();

    await store.save(
      createConversation({
        id: "conv-1",
        createdAt: new Date("2026-01-01T01:00:00.000Z"),
        updatedAt: new Date("2026-01-01T03:00:00.000Z"),
      }),
    );
    await store.save(
      createConversation({
        id: "conv-2",
        createdAt: new Date("2026-01-01T03:00:00.000Z"),
        updatedAt: new Date("2026-01-01T01:00:00.000Z"),
      }),
    );

    const byUpdated = await store.list({ orderBy: "updated" });
    expect(byUpdated.map((item) => item.id)).toEqual(["conv-1", "conv-2"]);

    const byCreated = await store.list({ orderBy: "created" });
    expect(byCreated.map((item) => item.id)).toEqual(["conv-2", "conv-1"]);
  });
});
