import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { SQLiteConversationStore } from "../../src/conversation/sqlite-store";
import type { Conversation } from "../../src/types";

function createConversation(overrides?: Partial<Conversation>): Conversation {
  const createdAt = overrides?.createdAt ?? new Date("2026-02-12T12:00:00.000Z");
  const updatedAt = overrides?.updatedAt ?? new Date("2026-02-12T12:00:00.000Z");

  return {
    id: overrides?.id ?? "conv-sqlite-1",
    title: overrides?.title ?? "SQLite Conversation",
    model: overrides?.model ?? "claude-3-5-sonnet",
    provider: overrides?.provider ?? "anthropic",
    personaId: overrides?.personaId,
    workspaceId: overrides?.workspaceId,
    metadata: overrides?.metadata,
    createdAt,
    updatedAt,
    messages: overrides?.messages ?? [],
  };
}

describe("SQLiteConversationStore", () => {
  test("bootstraps schema with WAL, FK constraints, and indexes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });
      store.close();

      const db = new Database(dbPath);

      const journalModeRow = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(journalModeRow.journal_mode.toLowerCase()).toBe("wal");

      const versionRow = db
        .query("SELECT MAX(version) AS version FROM schema_version")
        .get() as { version: number };
      expect(versionRow.version).toBe(1);

      const indexRows = db
        .query(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'index'
              AND name IN ('idx_messages_conversation_created', 'idx_conversations_updated')
          `,
        )
        .all() as Array<{ name: string }>;

      expect(indexRows.map((row) => row.name).sort()).toEqual([
        "idx_conversations_updated",
        "idx_messages_conversation_created",
      ]);

      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("persists and reloads full ordered history across restart", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const firstStore = new SQLiteConversationStore({ path: dbPath });

      const saveResult = await firstStore.save(
        createConversation({
          id: "conv-restart",
          title: "Restart Safe",
          workspaceId: "ws-1",
          messages: [
            {
              id: "msg-2",
              role: "assistant",
              content: "response",
              createdAt: new Date("2026-02-12T12:00:02.000Z"),
              metadata: {
                provider: "anthropic",
                model: "claude-3-5-sonnet",
              },
              toolCalls: [
                {
                  id: "tool-1",
                  name: "calendar.list",
                  arguments: { range: "today" },
                },
              ],
            },
            {
              id: "msg-1",
              role: "user",
              content: "hello",
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
            {
              id: "msg-3",
              role: "assistant",
              content: "completed",
              createdAt: new Date("2026-02-12T12:00:03.000Z"),
              metadata: {
                completedAt: "2026-02-12T12:00:03.500Z",
                errorCode: "",
              },
            },
          ],
        }),
      );

      expect(saveResult.ok).toBe(true);
      firstStore.close();

      const secondStore = new SQLiteConversationStore({ path: dbPath });
      const loaded = await secondStore.load("conv-restart");

      expect(loaded.ok).toBe(true);
      if (!loaded.ok || !loaded.value) {
        throw new Error("Expected conversation to load from sqlite store");
      }

      expect(loaded.value.id).toBe("conv-restart");
      expect(loaded.value.workspaceId).toBe("ws-1");
      expect(loaded.value.messages.map((message) => message.id)).toEqual(["msg-1", "msg-2", "msg-3"]);
      expect(loaded.value.messages[1]?.toolCalls?.[0]?.name).toBe("calendar.list");

      const listResult = await secondStore.list({ orderBy: "updated" });
      expect(listResult.ok).toBe(true);
      expect(listResult.ok && listResult.value[0]?.id).toBe("conv-restart");

      const updateResult = await secondStore.updateTitle("conv-restart", "Updated title");
      expect(updateResult.ok).toBe(true);

      const updated = await secondStore.load("conv-restart");
      expect(updated.ok).toBe(true);
      expect(updated.ok && updated.value?.title).toBe("Updated title");

      const deleteResult = await secondStore.delete("conv-restart");
      expect(deleteResult.ok).toBe(true);
      expect(deleteResult.ok && deleteResult.value).toBe(true);

      const afterDelete = await secondStore.load("conv-restart");
      expect(afterDelete.ok).toBe(true);
      expect(afterDelete.ok && afterDelete.value).toBeNull();

      secondStore.close();

      const db = new Database(dbPath);
      const remainingMessageRows = db
        .query("SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?1")
        .get("conv-restart") as { count: number };
      expect(remainingMessageRows.count).toBe(0);
      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("uses message history index for ordered retrieval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });
      const saveResult = await store.save(
        createConversation({
          id: "conv-query-plan",
          messages: [
            {
              id: "msg-1",
              role: "user",
              content: "one",
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
          ],
        }),
      );
      expect(saveResult.ok).toBe(true);
      store.close();

      const db = new Database(dbPath);
      const queryPlanRows = db
        .query(
          `
            EXPLAIN QUERY PLAN
            SELECT id, content
            FROM messages
            WHERE conversation_id = ?1
            ORDER BY created_at ASC, id ASC
          `,
        )
        .all("conv-query-plan") as Array<{ detail: string }>;

      expect(queryPlanRows.some((row) => row.detail.includes("idx_messages_conversation_created"))).toBe(
        true,
      );

      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
