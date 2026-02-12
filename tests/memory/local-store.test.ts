import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LocalFileMemoryStore } from "../../src/memory/local-store";
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

describe("LocalFileMemoryStore", () => {
  test("saves and reloads entries from disk", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-memory-"));

    try {
      const filePath = join(dir, "memory.json");
      const firstStore = new LocalFileMemoryStore(filePath);
      const saved = await firstStore.save(
        createInput({
          content: "Remember timezone is UTC",
          type: "fact",
          tags: ["timezone"],
        }),
      );

      const secondStore = new LocalFileMemoryStore(filePath);
      const loaded = await secondStore.get(saved.id);

      expect(loaded).not.toBeNull();
      expect(loaded?.content).toBe("Remember timezone is UTC");
      expect(loaded?.type).toBe("fact");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("creates file when it does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-memory-"));

    try {
      const filePath = join(dir, "nested", "memory.json");
      const store = new LocalFileMemoryStore(filePath);
      await store.save(createInput({ content: "Create backing file" }));

      const exists = await Bun.file(filePath).exists();
      expect(exists).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("writes atomically without leftover temp files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-memory-"));

    try {
      const filePath = join(dir, "memory.json");
      const store = new LocalFileMemoryStore(filePath);

      await store.save(createInput({ content: "Entry 1" }));
      await store.save(createInput({ content: "Entry 2" }));
      await store.save(createInput({ content: "Entry 3" }));

      const files = await readdir(dir);
      const tempFiles = files.filter((name) => name.startsWith("memory.json.tmp-"));

      expect(tempFiles).toHaveLength(0);
      expect(files).toContain("memory.json");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("search works after reloading store", async () => {
    const dir = await mkdtemp(join(tmpdir(), "reins-memory-"));

    try {
      const filePath = join(dir, "memory.json");
      const firstStore = new LocalFileMemoryStore(filePath);
      await firstStore.save(
        createInput({
          content: "User prefers concise answers",
          tags: ["preferences", "style"],
          importance: 0.8,
          type: "preference",
        }),
      );
      await firstStore.save(
        createInput({
          content: "Office closes at 6pm",
          tags: ["schedule"],
          importance: 0.4,
          type: "fact",
        }),
      );

      const reloaded = new LocalFileMemoryStore(filePath);
      const results = await reloaded.search({ query: "concise", tags: ["style"] });

      expect(results).toHaveLength(1);
      expect(results[0]?.entry.type).toBe("preference");
      expect(results[0]?.entry.content).toContain("concise");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
