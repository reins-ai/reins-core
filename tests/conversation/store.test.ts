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

    const saveResult = await store.save(conversation);
    expect(saveResult.ok).toBe(true);

    const existsResult = await store.exists("conv-basic");
    expect(existsResult.ok).toBe(true);
    expect(existsResult.ok && existsResult.value).toBe(true);
    const missingResult = await store.exists("missing");
    expect(missingResult.ok).toBe(true);
    expect(missingResult.ok && missingResult.value).toBe(false);

    const loaded = await store.load("conv-basic");
    expect(loaded.ok).toBe(true);
    expect(loaded.ok && loaded.value).not.toBeNull();
    expect(loaded.ok && loaded.value?.id).toBe("conv-basic");

    const deleted = await store.delete("conv-basic");
    expect(deleted.ok).toBe(true);
    expect(deleted.ok && deleted.value).toBe(true);
    const deletedAgain = await store.delete("conv-basic");
    expect(deletedAgain.ok).toBe(true);
    expect(deletedAgain.ok && deletedAgain.value).toBe(false);
    const missing = await store.load("conv-basic");
    expect(missing.ok).toBe(true);
    expect(missing.ok && missing.value).toBeNull();
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

    const saveResult = await store.save(original);
    expect(saveResult.ok).toBe(true);

    original.title = "mutated-after-save";
    original.messages[0]!.content = "changed";

    const loaded = await store.load("conv-clone");
    expect(loaded.ok).toBe(true);
    expect(loaded.ok && loaded.value).not.toBeNull();
    expect(loaded.ok && loaded.value?.title).toBe("Conversation 1");
    expect(loaded.ok && loaded.value?.messages[0]?.content).toBe("hello");

    if (!loaded.ok || !loaded.value) {
      throw new Error("Expected conversation to load");
    }

    loaded.value.messages[0]!.content = "mutated-loaded";
    const loadedAgain = await store.load("conv-clone");
    expect(loadedAgain.ok).toBe(true);
    expect(loadedAgain.ok && loadedAgain.value?.messages[0]?.content).toBe("hello");
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
    expect(ws1.ok).toBe(true);
    expect(ws1.ok && ws1.value.map((item) => item.id)).toEqual(["conv-b", "conv-a"]);

    const paged = await store.list({ workspaceId: "ws-1", offset: 1, limit: 1 });
    expect(paged.ok).toBe(true);
    expect(paged.ok && paged.value).toHaveLength(1);
    expect(paged.ok && paged.value[0]?.id).toBe("conv-a");
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
    expect(byUpdated.ok).toBe(true);
    expect(byUpdated.ok && byUpdated.value.map((item) => item.id)).toEqual(["conv-1", "conv-2"]);

    const byCreated = await store.list({ orderBy: "created" });
    expect(byCreated.ok).toBe(true);
    expect(byCreated.ok && byCreated.value.map((item) => item.id)).toEqual(["conv-2", "conv-1"]);
  });
});
