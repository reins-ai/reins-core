import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import { SQLiteConversationStore } from "../../src/conversation/sqlite-store";
import type { ContentBlock, Conversation, Message } from "../../src/types";

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

/**
 * Create a v1 database (without content_blocks column) to test migration.
 * Simulates a database created before the tool block persistence feature.
 */
function createV1Database(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA foreign_keys=ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      persona_id TEXT,
      workspace_id TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('system', 'user', 'assistant', 'tool')),
      content TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      tool_calls_json TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      error_code TEXT,
      error_message TEXT,
      FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
      ON messages(conversation_id, created_at, id);

    CREATE INDEX IF NOT EXISTS idx_conversations_updated
      ON conversations(updated_at DESC);

    INSERT INTO schema_version(version, applied_at)
    VALUES (1, '2026-02-12T00:00:00.000Z');
  `);

  return db;
}

function insertV1Message(
  db: Database,
  conversationId: string,
  message: { id: string; role: string; content: string; createdAt: string },
): void {
  db.query(
    `INSERT INTO messages (id, conversation_id, role, content, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5)`,
  ).run(message.id, conversationId, message.role, message.content, message.createdAt);
}

function insertV1Conversation(
  db: Database,
  conv: { id: string; title: string; provider: string; model: string; createdAt: string; updatedAt: string },
): void {
  db.query(
    `INSERT INTO conversations (id, title, provider, model, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  ).run(conv.id, conv.title, conv.provider, conv.model, conv.createdAt, conv.updatedAt);
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
      expect(versionRow.version).toBe(2);

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

  test("fresh database includes content_blocks column", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });
      store.close();

      const db = new Database(dbPath);
      const columns = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);

      expect(columnNames).toContain("content");
      expect(columnNames).toContain("content_blocks");

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

describe("SQLiteConversationStore — tool block persistence", () => {
  test("saves message with string content and null content_blocks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });

      await store.save(
        createConversation({
          id: "conv-text",
          messages: [
            {
              id: "msg-text",
              role: "user",
              content: "plain text message",
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
          ],
        }),
      );

      store.close();

      const db = new Database(dbPath);
      const row = db.query("SELECT content, content_blocks FROM messages WHERE id = ?1").get("msg-text") as {
        content: string;
        content_blocks: string | null;
      };

      expect(row.content).toBe("plain text message");
      expect(row.content_blocks).toBeNull();

      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("saves message with ContentBlock[] and populates both columns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });

      const toolBlocks: ContentBlock[] = [
        { type: "text", text: "Let me check that for you." },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "calendar.list",
          input: { range: "today" },
        },
      ];

      await store.save(
        createConversation({
          id: "conv-blocks",
          messages: [
            {
              id: "msg-blocks",
              role: "assistant",
              content: toolBlocks,
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
          ],
        }),
      );

      store.close();

      const db = new Database(dbPath);
      const row = db.query("SELECT content, content_blocks FROM messages WHERE id = ?1").get("msg-blocks") as {
        content: string;
        content_blocks: string | null;
      };

      expect(row.content).toBe("Let me check that for you.");
      expect(row.content_blocks).not.toBeNull();

      const parsed = JSON.parse(row.content_blocks!) as ContentBlock[];
      expect(parsed).toHaveLength(2);
      expect(parsed[0]).toEqual({ type: "text", text: "Let me check that for you." });
      expect(parsed[1]).toEqual({
        type: "tool_use",
        id: "toolu_01",
        name: "calendar.list",
        input: { range: "today" },
      });

      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reads message with ContentBlock[] and returns structured content", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });

      const toolBlocks: ContentBlock[] = [
        { type: "text", text: "Here are the results." },
        {
          type: "tool_use",
          id: "toolu_02",
          name: "notes.search",
          input: { query: "meeting notes" },
        },
      ];

      await store.save(
        createConversation({
          id: "conv-read-blocks",
          messages: [
            {
              id: "msg-read-blocks",
              role: "assistant",
              content: toolBlocks,
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
          ],
        }),
      );

      const loaded = await store.load("conv-read-blocks");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || !loaded.value) {
        throw new Error("Expected conversation to load");
      }

      const message = loaded.value.messages[0]!;
      expect(Array.isArray(message.content)).toBe(true);

      const blocks = message.content as ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]).toEqual({ type: "text", text: "Here are the results." });
      expect(blocks[1]).toEqual({
        type: "tool_use",
        id: "toolu_02",
        name: "notes.search",
        input: { query: "meeting notes" },
      });

      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("reads message with string content and returns string", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });

      await store.save(
        createConversation({
          id: "conv-read-text",
          messages: [
            {
              id: "msg-read-text",
              role: "user",
              content: "just a string",
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
          ],
        }),
      );

      const loaded = await store.load("conv-read-text");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || !loaded.value) {
        throw new Error("Expected conversation to load");
      }

      const message = loaded.value.messages[0]!;
      expect(typeof message.content).toBe("string");
      expect(message.content).toBe("just a string");

      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves tool_result blocks with error flags", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });

      const resultBlocks: ContentBlock[] = [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "Error: file not found",
          is_error: true,
        },
      ];

      await store.save(
        createConversation({
          id: "conv-tool-result",
          messages: [
            {
              id: "msg-tool-result",
              role: "user",
              content: resultBlocks,
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
          ],
        }),
      );

      const loaded = await store.load("conv-tool-result");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || !loaded.value) {
        throw new Error("Expected conversation to load");
      }

      const message = loaded.value.messages[0]!;
      expect(Array.isArray(message.content)).toBe(true);

      const blocks = message.content as ContentBlock[];
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toEqual({
        type: "tool_result",
        tool_use_id: "toolu_01",
        content: "Error: file not found",
        is_error: true,
      });

      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves complex tool arguments through roundtrip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });

      const complexInput = {
        filters: [
          { field: "date", op: ">=", value: "2026-01-01" },
          { field: "status", op: "in", value: ["active", "pending"] },
        ],
        sort: { field: "priority", direction: "desc" },
        limit: 50,
        nested: { deep: { value: true } },
      };

      const blocks: ContentBlock[] = [
        {
          type: "tool_use",
          id: "toolu_complex",
          name: "database.query",
          input: complexInput,
        },
      ];

      await store.save(
        createConversation({
          id: "conv-complex-args",
          messages: [
            {
              id: "msg-complex",
              role: "assistant",
              content: blocks,
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
          ],
        }),
      );

      const loaded = await store.load("conv-complex-args");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || !loaded.value) {
        throw new Error("Expected conversation to load");
      }

      const loadedBlocks = loaded.value.messages[0]!.content as ContentBlock[];
      const toolUse = loadedBlocks[0]!;
      expect(toolUse.type).toBe("tool_use");
      if (toolUse.type === "tool_use") {
        expect(toolUse.input).toEqual(complexInput);
      }

      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("handles mixed text and tool block messages in same conversation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });

      const messages: Message[] = [
        {
          id: "msg-1",
          role: "user",
          content: "What's on my calendar?",
          createdAt: new Date("2026-02-12T12:00:01.000Z"),
        },
        {
          id: "msg-2",
          role: "assistant",
          content: [
            { type: "text", text: "Let me check." },
            { type: "tool_use", id: "toolu_01", name: "calendar.list", input: { range: "today" } },
          ],
          createdAt: new Date("2026-02-12T12:00:02.000Z"),
        },
        {
          id: "msg-3",
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: "Meeting at 3pm",
            },
          ],
          createdAt: new Date("2026-02-12T12:00:03.000Z"),
        },
        {
          id: "msg-4",
          role: "assistant",
          content: "You have a meeting at 3pm today.",
          createdAt: new Date("2026-02-12T12:00:04.000Z"),
        },
      ];

      await store.save(createConversation({ id: "conv-mixed", messages }));

      const loaded = await store.load("conv-mixed");
      expect(loaded.ok).toBe(true);
      if (!loaded.ok || !loaded.value) {
        throw new Error("Expected conversation to load");
      }

      const loadedMessages = loaded.value.messages;
      expect(loadedMessages).toHaveLength(4);

      expect(typeof loadedMessages[0]!.content).toBe("string");
      expect(loadedMessages[0]!.content).toBe("What's on my calendar?");

      expect(Array.isArray(loadedMessages[1]!.content)).toBe(true);
      expect((loadedMessages[1]!.content as ContentBlock[])).toHaveLength(2);

      expect(Array.isArray(loadedMessages[2]!.content)).toBe(true);
      const resultBlock = (loadedMessages[2]!.content as ContentBlock[])[0]!;
      expect(resultBlock.type).toBe("tool_result");

      expect(typeof loadedMessages[3]!.content).toBe("string");
      expect(loadedMessages[3]!.content).toBe("You have a meeting at 3pm today.");

      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("SQLiteConversationStore — v1 to v2 migration", () => {
  test("migrates v1 database to v2 adding content_blocks column", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const v1db = createV1Database(dbPath);
      v1db.close();

      const store = new SQLiteConversationStore({ path: dbPath });
      store.close();

      const db = new Database(dbPath);

      const versionRow = db
        .query("SELECT MAX(version) AS version FROM schema_version")
        .get() as { version: number };
      expect(versionRow.version).toBe(2);

      const columns = db.query("PRAGMA table_info(messages)").all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name)).toContain("content_blocks");

      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("preserves existing v1 messages after migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const v1db = createV1Database(dbPath);

      insertV1Conversation(v1db, {
        id: "conv-legacy",
        title: "Legacy Chat",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        createdAt: "2026-02-12T12:00:00.000Z",
        updatedAt: "2026-02-12T12:00:00.000Z",
      });

      insertV1Message(v1db, "conv-legacy", {
        id: "msg-legacy-1",
        role: "user",
        content: "Hello from v1",
        createdAt: "2026-02-12T12:00:01.000Z",
      });

      insertV1Message(v1db, "conv-legacy", {
        id: "msg-legacy-2",
        role: "assistant",
        content: "Hi there from v1",
        createdAt: "2026-02-12T12:00:02.000Z",
      });

      v1db.close();

      const store = new SQLiteConversationStore({ path: dbPath });
      const loaded = await store.load("conv-legacy");

      expect(loaded.ok).toBe(true);
      if (!loaded.ok || !loaded.value) {
        throw new Error("Expected conversation to load after migration");
      }

      expect(loaded.value.messages).toHaveLength(2);
      expect(loaded.value.messages[0]!.content).toBe("Hello from v1");
      expect(loaded.value.messages[1]!.content).toBe("Hi there from v1");
      expect(typeof loaded.value.messages[0]!.content).toBe("string");
      expect(typeof loaded.value.messages[1]!.content).toBe("string");

      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("legacy messages have null content_blocks after migration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const v1db = createV1Database(dbPath);

      insertV1Conversation(v1db, {
        id: "conv-null-blocks",
        title: "Null Blocks",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        createdAt: "2026-02-12T12:00:00.000Z",
        updatedAt: "2026-02-12T12:00:00.000Z",
      });

      insertV1Message(v1db, "conv-null-blocks", {
        id: "msg-null-blocks",
        role: "user",
        content: "text only",
        createdAt: "2026-02-12T12:00:01.000Z",
      });

      v1db.close();

      // Open with store to trigger migration
      const store = new SQLiteConversationStore({ path: dbPath });
      store.close();

      const db = new Database(dbPath);
      const row = db
        .query("SELECT content, content_blocks FROM messages WHERE id = ?1")
        .get("msg-null-blocks") as { content: string; content_blocks: string | null };

      expect(row.content).toBe("text only");
      expect(row.content_blocks).toBeNull();

      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("mixed database with old and new messages works correctly", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const v1db = createV1Database(dbPath);

      insertV1Conversation(v1db, {
        id: "conv-mixed-era",
        title: "Mixed Era",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        createdAt: "2026-02-12T12:00:00.000Z",
        updatedAt: "2026-02-12T12:00:00.000Z",
      });

      insertV1Message(v1db, "conv-mixed-era", {
        id: "msg-old",
        role: "user",
        content: "Old message from v1",
        createdAt: "2026-02-12T12:00:01.000Z",
      });

      v1db.close();

      const store = new SQLiteConversationStore({ path: dbPath });

      // Save a new conversation with tool blocks alongside the old one
      await store.save(
        createConversation({
          id: "conv-new-era",
          messages: [
            {
              id: "msg-new",
              role: "assistant",
              content: [
                { type: "text", text: "Using tools now." },
                { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "ls" } },
              ],
              createdAt: new Date("2026-02-12T12:00:02.000Z"),
            },
          ],
        }),
      );

      // Load old conversation — should still work
      const oldLoaded = await store.load("conv-mixed-era");
      expect(oldLoaded.ok).toBe(true);
      if (!oldLoaded.ok || !oldLoaded.value) {
        throw new Error("Expected old conversation to load");
      }
      expect(oldLoaded.value.messages[0]!.content).toBe("Old message from v1");
      expect(typeof oldLoaded.value.messages[0]!.content).toBe("string");

      // Load new conversation — should have tool blocks
      const newLoaded = await store.load("conv-new-era");
      expect(newLoaded.ok).toBe(true);
      if (!newLoaded.ok || !newLoaded.value) {
        throw new Error("Expected new conversation to load");
      }
      expect(Array.isArray(newLoaded.value.messages[0]!.content)).toBe(true);
      const blocks = newLoaded.value.messages[0]!.content as ContentBlock[];
      expect(blocks[1]!.type).toBe("tool_use");

      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("v1 messages with serialized content_blocks in content column are deserialized", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const v1db = createV1Database(dbPath);

      insertV1Conversation(v1db, {
        id: "conv-serialized",
        title: "Serialized Blocks",
        provider: "anthropic",
        model: "claude-3-5-sonnet",
        createdAt: "2026-02-12T12:00:00.000Z",
        updatedAt: "2026-02-12T12:00:00.000Z",
      });

      // Simulate a message saved by Task 3.1's serializeContent() before migration
      const serializedBlocks = JSON.stringify([
        { type: "text", text: "Checking..." },
        { type: "tool_use", id: "toolu_pre", name: "read", input: { path: "/tmp/test" } },
      ]);

      insertV1Message(v1db, "conv-serialized", {
        id: "msg-serialized",
        role: "assistant",
        content: serializedBlocks,
        createdAt: "2026-02-12T12:00:01.000Z",
      });

      v1db.close();

      const store = new SQLiteConversationStore({ path: dbPath });
      const loaded = await store.load("conv-serialized");

      expect(loaded.ok).toBe(true);
      if (!loaded.ok || !loaded.value) {
        throw new Error("Expected conversation to load");
      }

      // deserializeContent should detect the JSON array and parse it
      const message = loaded.value.messages[0]!;
      expect(Array.isArray(message.content)).toBe(true);

      const blocks = message.content as ContentBlock[];
      expect(blocks).toHaveLength(2);
      expect(blocks[0]!.type).toBe("text");
      expect(blocks[1]!.type).toBe("tool_use");
      if (blocks[1]!.type === "tool_use") {
        expect(blocks[1]!.name).toBe("read");
      }

      store.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("migration is idempotent — opening v2 database does not re-migrate", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      // First open creates v2
      const store1 = new SQLiteConversationStore({ path: dbPath });
      store1.close();

      // Second open should not fail or duplicate version rows
      const store2 = new SQLiteConversationStore({ path: dbPath });
      store2.close();

      const db = new Database(dbPath);
      const versionRows = db
        .query("SELECT version FROM schema_version ORDER BY version")
        .all() as Array<{ version: number }>;

      expect(versionRows.map((r) => r.version)).toEqual([1, 2]);

      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("content column stores text fallback for tool block messages", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });

      const blocks: ContentBlock[] = [
        { type: "text", text: "First part. " },
        { type: "text", text: "Second part." },
        { type: "tool_use", id: "toolu_01", name: "bash", input: { command: "echo hi" } },
      ];

      await store.save(
        createConversation({
          id: "conv-fallback",
          messages: [
            {
              id: "msg-fallback",
              role: "assistant",
              content: blocks,
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
          ],
        }),
      );

      store.close();

      const db = new Database(dbPath);
      const row = db
        .query("SELECT content, content_blocks FROM messages WHERE id = ?1")
        .get("msg-fallback") as { content: string; content_blocks: string | null };

      // content column should have concatenated text from text blocks
      expect(row.content).toBe("First part. Second part.");
      // content_blocks should have the full JSON
      expect(row.content_blocks).not.toBeNull();

      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("tool-only blocks produce empty string in content column", async () => {
    const directory = await mkdtemp(join(tmpdir(), "reins-sqlite-store-"));
    const dbPath = join(directory, "conversation.db");

    try {
      const store = new SQLiteConversationStore({ path: dbPath });

      const blocks: ContentBlock[] = [
        {
          type: "tool_result",
          tool_use_id: "toolu_01",
          content: "result data",
        },
      ];

      await store.save(
        createConversation({
          id: "conv-tool-only",
          messages: [
            {
              id: "msg-tool-only",
              role: "user",
              content: blocks,
              createdAt: new Date("2026-02-12T12:00:01.000Z"),
            },
          ],
        }),
      );

      store.close();

      const db = new Database(dbPath);
      const row = db
        .query("SELECT content, content_blocks FROM messages WHERE id = ?1")
        .get("msg-tool-only") as { content: string; content_blocks: string | null };

      // No text blocks → empty string in content column
      expect(row.content).toBe("");
      expect(row.content_blocks).not.toBeNull();

      db.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("deserializeContent", () => {
  // These tests verify the utility function used by the read path
  const { deserializeContent } = require("../../src/types/conversation");

  test("returns plain string for non-JSON content", () => {
    expect(deserializeContent("hello world")).toBe("hello world");
  });

  test("returns plain string for non-array JSON", () => {
    expect(deserializeContent('{"key": "value"}')).toBe('{"key": "value"}');
  });

  test("returns plain string for empty array", () => {
    expect(deserializeContent("[]")).toBe("[]");
  });

  test("returns plain string for array without type field", () => {
    expect(deserializeContent('[{"name": "test"}]')).toBe('[{"name": "test"}]');
  });

  test("returns plain string for array with unknown type", () => {
    expect(deserializeContent('[{"type": "unknown"}]')).toBe('[{"type": "unknown"}]');
  });

  test("parses valid text block array", () => {
    const input = JSON.stringify([{ type: "text", text: "hello" }]);
    const result = deserializeContent(input);
    expect(Array.isArray(result)).toBe(true);
    expect((result as ContentBlock[])[0]).toEqual({ type: "text", text: "hello" });
  });

  test("parses valid tool_use block array", () => {
    const input = JSON.stringify([
      { type: "tool_use", id: "t1", name: "bash", input: { cmd: "ls" } },
    ]);
    const result = deserializeContent(input);
    expect(Array.isArray(result)).toBe(true);
  });

  test("parses valid tool_result block array", () => {
    const input = JSON.stringify([
      { type: "tool_result", tool_use_id: "t1", content: "output" },
    ]);
    const result = deserializeContent(input);
    expect(Array.isArray(result)).toBe(true);
  });

  test("returns plain string for malformed JSON starting with [", () => {
    expect(deserializeContent("[not valid json")).toBe("[not valid json");
  });
});
