import { afterAll, describe, expect, it } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { MemoryDaemonService } from "../../../src/daemon/memory-daemon-service";
import { parse } from "../../../src/memory/io";
import type { MemoryRecord } from "../../../src/memory/types";
import { ok } from "../../../src/result";
import {
  cleanupIsolatedMemoryStorage,
  closeMemoryRuntime,
  createDeterministicMemoryInputs,
  createIsolatedMemoryStorage,
  createMemoryRuntime,
  type MemoryStoragePaths,
} from "./test-fixtures";

const storageToCleanup: MemoryStoragePaths[] = [];

afterAll(async () => {
  for (const storage of storageToCleanup) {
    await cleanupIsolatedMemoryStorage(storage);
  }
});

describe("Memory persistence restart E2E", () => {
  it("retrieves Session A memories in Session B after restart", async () => {
    const storage = await createIsolatedMemoryStorage();
    storageToCleanup.push(storage);

    const fixtures = createDeterministicMemoryInputs("conv-restart-sessions");
    const sessionA = await createMemoryRuntime(storage);
    const createdInSessionA: MemoryRecord[] = [];

    try {
      for (const input of fixtures) {
        const created = await sessionA.repository.create(input);
        expect(created.ok).toBe(true);
        if (!created.ok) {
          throw created.error;
        }

        createdInSessionA.push(created.value);
      }
    } finally {
      await closeMemoryRuntime(sessionA);
    }

    const sessionB = await createMemoryRuntime(storage);
    try {
      const loaded = await sessionB.repository.list({ limit: 10 });
      expect(loaded.ok).toBe(true);
      if (!loaded.ok) {
        throw loaded.error;
      }

      const loadedById = new Map(loaded.value.map((record) => [record.id, record]));
      expect(loadedById.size).toBe(createdInSessionA.length);

      for (const created of createdInSessionA) {
        const persisted = loadedById.get(created.id);
        expect(persisted).toBeDefined();
        if (!persisted) {
          continue;
        }

        expect(persisted.content).toBe(created.content);
        expect(persisted.type).toBe(created.type);
        expect(persisted.layer).toBe(created.layer);
        expect(persisted.tags).toEqual(created.tags);
        expect(persisted.entities).toEqual(created.entities);
        expect(persisted.importance).toBe(created.importance);
        expect(persisted.confidence).toBe(created.confidence);
        expect(persisted.provenance.sourceType).toBe(created.provenance.sourceType);
        expect(persisted.provenance.conversationId).toBe(created.provenance.conversationId);
        expect(persisted.createdAt.toISOString()).toBe(created.createdAt.toISOString());
        expect(persisted.updatedAt.toISOString()).toBe(created.updatedAt.toISOString());
      }

      const searchResult = sessionB.bm25.search(
        "concise architecture diffs migration notes",
        { limit: 5 },
      );
      expect(searchResult.ok).toBe(true);
      if (!searchResult.ok) {
        throw searchResult.error;
      }

      expect(searchResult.value.length).toBeGreaterThanOrEqual(1);
      expect(
        searchResult.value.some((result) =>
          result.content.includes("concise architecture diffs"),
        ),
      ).toBe(true);
    } finally {
      await closeMemoryRuntime(sessionB);
    }
  });

  it("preserves multiple memory types across process restart", async () => {
    const storage = await createIsolatedMemoryStorage();
    storageToCleanup.push(storage);

    const sessionA = await createMemoryRuntime(storage);
    try {
      for (const input of createDeterministicMemoryInputs("conv-restart-types")) {
        const result = await sessionA.repository.create(input);
        expect(result.ok).toBe(true);
      }
    } finally {
      await closeMemoryRuntime(sessionA);
    }

    const sessionB = await createMemoryRuntime(storage);
    try {
      const listResult = await sessionB.repository.list({ limit: 10 });
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) {
        throw listResult.error;
      }

      const types = new Set(listResult.value.map((record) => record.type));
      expect(types.has("fact")).toBe(true);
      expect(types.has("preference")).toBe(true);
      expect(types.has("decision")).toBe(true);
    } finally {
      await closeMemoryRuntime(sessionB);
    }
  });

  it("loads SQLite indexes and FTS behavior after restart", async () => {
    const storage = await createIsolatedMemoryStorage();
    storageToCleanup.push(storage);

    const sessionA = await createMemoryRuntime(storage);
    try {
      const writeResult = await sessionA.repository.create(
        createDeterministicMemoryInputs("conv-restart-indexes")[2],
      );
      expect(writeResult.ok).toBe(true);
    } finally {
      await closeMemoryRuntime(sessionA);
    }

    const sessionB = await createMemoryRuntime(storage);
    try {
      const db = sessionB.db.getDb();
      const ftsTable = db
        .query(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts' LIMIT 1",
        )
        .get() as { name: string } | null;
      expect(ftsTable?.name).toBe("memory_fts");

      const expectedIndexes = [
        "idx_memories_type",
        "idx_memories_layer",
        "idx_memories_source_type",
        "idx_memories_importance",
        "idx_memories_created_at",
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

      const indexNames = new Set(indexRows.map((row) => row.name));
      for (const index of expectedIndexes) {
        expect(indexNames.has(index)).toBe(true);
      }

      const searchResult = sessionB.bm25.search("release train R8", { limit: 3 });
      expect(searchResult.ok).toBe(true);
      if (!searchResult.ok) {
        throw searchResult.error;
      }

      expect(searchResult.value.length).toBe(1);
      expect(searchResult.value[0].content).toContain("release train R8");
    } finally {
      await closeMemoryRuntime(sessionB);
    }
  });

  it("keeps markdown and database representations consistent after restart", async () => {
    const storage = await createIsolatedMemoryStorage();
    storageToCleanup.push(storage);

    const fixtures = createDeterministicMemoryInputs("conv-restart-markdown");
    const sessionA = await createMemoryRuntime(storage);
    try {
      for (const fixture of fixtures) {
        const created = await sessionA.repository.create(fixture);
        expect(created.ok).toBe(true);
      }
    } finally {
      await closeMemoryRuntime(sessionA);
    }

    const sessionB = await createMemoryRuntime(storage);
    try {
      const reconciliation = await sessionB.repository.reconcile();
      expect(reconciliation.ok).toBe(true);
      if (!reconciliation.ok) {
        throw reconciliation.error;
      }

      expect(reconciliation.value.isConsistent).toBe(true);
      expect(reconciliation.value.contentMismatches).toEqual([]);
      expect(reconciliation.value.missingFiles).toEqual([]);
      expect(reconciliation.value.orphanedFiles).toEqual([]);

      const fileNames = (await readdir(storage.dataDir)).filter((name) =>
        name.endsWith(".md"),
      );
      expect(fileNames.length).toBe(fixtures.length);

      const parsedIds = new Set<string>();
      for (const fileName of fileNames) {
        const markdown = await readFile(join(storage.dataDir, fileName), "utf8");
        const parsed = parse(markdown);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
          throw parsed.error;
        }

        parsedIds.add(parsed.value.id);
      }

      const listed = await sessionB.repository.list({ limit: 10 });
      expect(listed.ok).toBe(true);
      if (!listed.ok) {
        throw listed.error;
      }

      for (const memory of listed.value) {
        expect(parsedIds.has(memory.id)).toBe(true);
      }
    } finally {
      await closeMemoryRuntime(sessionB);
    }
  });

  it("retains retrievability across daemon stop/start cycles", async () => {
    const storage = await createIsolatedMemoryStorage();
    storageToCleanup.push(storage);

    const sessionA = await createMemoryRuntime(storage);
    const daemonA = new MemoryDaemonService({
      dbPath: storage.dbPath,
      dataDir: storage.dataDir,
      memoryService: sessionA.service,
      initializeStorage: async () => {
        const initialized = sessionA.db.initialize();
        return initialized.ok
          ? ok(undefined)
          : initialized;
      },
      scanDataDirectory: async () => {
        const countResult = await sessionA.repository.count();
        return countResult.ok ? ok(countResult.value) : countResult;
      },
      flushPendingWrites: async () => ok(undefined),
    });

    try {
      const startA = await daemonA.start();
      expect(startA.ok).toBe(true);

      const writeA = await sessionA.service.rememberExplicit({
        content:
          "RESTART-E2E-DAEMON: Session A persisted this memory before daemon shutdown.",
        type: "fact",
        conversationId: "conv-daemon-restart",
        messageId: "daemon-session-a",
      });
      expect(writeA.ok).toBe(true);

      const stopA = await daemonA.stop();
      expect(stopA.ok).toBe(true);
    } finally {
      await closeMemoryRuntime(sessionA);
    }

    const sessionB = await createMemoryRuntime(storage);
    const daemonB = new MemoryDaemonService({
      dbPath: storage.dbPath,
      dataDir: storage.dataDir,
      memoryService: sessionB.service,
      initializeStorage: async () => {
        const initialized = sessionB.db.initialize();
        return initialized.ok
          ? ok(undefined)
          : initialized;
      },
      scanDataDirectory: async () => {
        const countResult = await sessionB.repository.count();
        return countResult.ok ? ok(countResult.value) : countResult;
      },
      flushPendingWrites: async () => ok(undefined),
    });

    try {
      const startB = await daemonB.start();
      expect(startB.ok).toBe(true);

      const health = await daemonB.healthCheck();
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.dbConnected).toBe(true);
        expect(health.value.memoryCount).toBeGreaterThanOrEqual(1);
      }

      const search = sessionB.bm25.search("persisted memory daemon shutdown", {
        limit: 3,
      });
      expect(search.ok).toBe(true);
      if (!search.ok) {
        throw search.error;
      }

      expect(search.value.length).toBeGreaterThanOrEqual(1);
      expect(
        search.value.some((result) =>
          result.content.includes("Session A persisted this memory before daemon shutdown."),
        ),
      ).toBe(true);

      const stopB = await daemonB.stop();
      expect(stopB.ok).toBe(true);
    } finally {
      await closeMemoryRuntime(sessionB);
    }
  });
});
