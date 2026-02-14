import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteMemoryDb } from "../../../src/memory/storage/sqlite-memory-db";

async function withTempDbPath(run: (dbPath: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "reins-memory-schema-"));
  const dbPath = join(directory, "memory.db");

  try {
    await run(dbPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("SqliteMemoryDb schema migrations", () => {
  test("applies migrations successfully on a fresh database", async () => {
    await withTempDbPath(async (dbPath) => {
      const memoryDb = new SqliteMemoryDb({ dbPath });
      const initResult = memoryDb.initialize();

      expect(initResult.ok).toBe(true);
      if (!initResult.ok) {
        throw initResult.error;
      }

      const db = memoryDb.getDb();

      const versionRows = db
        .query("SELECT version FROM schema_version ORDER BY version ASC")
        .all() as Array<{ version: number }>;
      expect(versionRows.map((row) => row.version)).toEqual([1, 2]);

      const tableRows = db
        .query(
          `
            SELECT name
            FROM sqlite_master
            WHERE (type = 'table' OR type = 'view')
              AND name IN (
                'memories',
                'memory_provenance',
                'consolidation_runs',
                'memory_embeddings',
                'document_sources',
                'document_chunks',
                'schema_version'
              )
          `,
        )
        .all() as Array<{ name: string }>;

      expect(tableRows.map((row) => row.name).sort()).toEqual([
        "consolidation_runs",
        "document_chunks",
        "document_sources",
        "memories",
        "memory_embeddings",
        "memory_provenance",
        "schema_version",
      ]);

      const ftsRow = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts' LIMIT 1",
        )
        .get() as { name: string } | null;
      expect(ftsRow?.name).toBe("memory_fts");

      memoryDb.close();
    });
  });

  test("migrations are idempotent when initialized twice", async () => {
    await withTempDbPath(async (dbPath) => {
      const first = new SqliteMemoryDb({ dbPath });
      const firstResult = first.initialize();
      expect(firstResult.ok).toBe(true);
      first.close();

      const second = new SqliteMemoryDb({ dbPath });
      const secondResult = second.initialize();
      expect(secondResult.ok).toBe(true);

      const db = second.getDb();
      const versionRows = db
        .query("SELECT version FROM schema_version ORDER BY version ASC")
        .all() as Array<{ version: number }>;
      expect(versionRows.map((row) => row.version)).toEqual([1, 2]);

      second.close();
    });
  });

  test("enables WAL mode", async () => {
    await withTempDbPath(async (dbPath) => {
      const memoryDb = new SqliteMemoryDb({ dbPath });
      const initResult = memoryDb.initialize();
      expect(initResult.ok).toBe(true);

      const db = memoryDb.getDb();
      const journalModeRow = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
      expect(journalModeRow.journal_mode.toLowerCase()).toBe("wal");

      memoryDb.close();
    });
  });

  test("syncs memory_fts via triggers on insert, update, and delete", async () => {
    await withTempDbPath(async (dbPath) => {
      const memoryDb = new SqliteMemoryDb({ dbPath });
      const initResult = memoryDb.initialize();
      expect(initResult.ok).toBe(true);

      const db = memoryDb.getDb();

      db.query(
        `
          INSERT INTO memories (id, content, type, source_type)
          VALUES (?1, ?2, ?3, ?4)
        `,
      ).run("mem-1", "Apollo mission details", "fact", "explicit");

      const insertMatch = db
        .query("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?1")
        .get("apollo") as { memory_id: string } | null;
      expect(insertMatch?.memory_id).toBe("mem-1");

      db.query("UPDATE memories SET content = ?2 WHERE id = ?1").run(
        "mem-1",
        "Gemini mission details",
      );

      const oldMatch = db
        .query("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?1")
        .get("apollo") as { memory_id: string } | null;
      expect(oldMatch).toBeNull();

      const updatedMatch = db
        .query("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?1")
        .get("gemini") as { memory_id: string } | null;
      expect(updatedMatch?.memory_id).toBe("mem-1");

      db.query("DELETE FROM memories WHERE id = ?1").run("mem-1");

      const deletedMatch = db
        .query("SELECT memory_id FROM memory_fts WHERE memory_fts MATCH ?1")
        .get("gemini") as { memory_id: string } | null;
      expect(deletedMatch).toBeNull();

      memoryDb.close();
    });
  });

  test("creates expected memory schema columns and indexes", async () => {
    await withTempDbPath(async (dbPath) => {
      const memoryDb = new SqliteMemoryDb({ dbPath });
      const initResult = memoryDb.initialize();
      expect(initResult.ok).toBe(true);

      const db = memoryDb.getDb();

      const memoryColumns = db.query("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
      expect(memoryColumns.map((column) => column.name)).toEqual([
        "id",
        "content",
        "type",
        "layer",
        "importance",
        "confidence",
        "tags",
        "entities",
        "source_type",
        "source_conversation_id",
        "source_message_id",
        "supersedes_id",
        "superseded_by_id",
        "access_count",
        "reinforcement_count",
        "last_accessed_at",
        "created_at",
        "updated_at",
      ]);

      const expectedIndexes = [
        "idx_memories_type",
        "idx_memories_layer",
        "idx_memories_source_type",
        "idx_memories_importance",
        "idx_memories_created_at",
        "idx_memory_embeddings_memory_id",
        "idx_memory_embeddings_provider_model",
        "idx_document_chunks_source_id",
        "idx_document_chunks_file_path",
      ];

      const indexRows = db
        .query(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'index' AND name IN (${expectedIndexes.map(() => "?").join(", ")})
          `,
        )
        .all(...expectedIndexes) as Array<{ name: string }>;

      expect(indexRows.map((row) => row.name).sort()).toEqual(expectedIndexes.sort());

      memoryDb.close();
    });
  });

  test("persists embedding provider metadata with vector payload", async () => {
    await withTempDbPath(async (dbPath) => {
      const memoryDb = new SqliteMemoryDb({ dbPath });
      const initResult = memoryDb.initialize();
      expect(initResult.ok).toBe(true);

      const db = memoryDb.getDb();

      db.query(
        `
          INSERT INTO memories (id, content, type, source_type)
          VALUES (?1, ?2, ?3, ?4)
        `,
      ).run("mem-embed-1", "Embedding target memory", "fact", "explicit");

      const vector = new Float32Array([0.12, 0.34, 0.56]);
      const vectorBlob = Buffer.from(vector.buffer.slice(0));

      db.query(
        `
          INSERT INTO memory_embeddings (id, memory_id, provider, model, dimension, version, vector)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        `,
      ).run(
        "emb-1",
        "mem-embed-1",
        "openai",
        "text-embedding-3-small",
        3,
        "2026-02",
        vectorBlob,
      );

      const row = db
        .query(
          `
            SELECT provider, model, dimension, version, vector
            FROM memory_embeddings
            WHERE id = ?1
          `,
        )
        .get("emb-1") as {
          provider: string;
          model: string;
          dimension: number;
          version: string;
          vector: Uint8Array;
        } | null;

      expect(row?.provider).toBe("openai");
      expect(row?.model).toBe("text-embedding-3-small");
      expect(row?.dimension).toBe(3);
      expect(row?.version).toBe("2026-02");
      expect((row?.vector.byteLength ?? 0) > 0).toBe(true);

      memoryDb.close();
    });
  });
});
