import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, serialize } from "../../../src/memory/io/markdown-memory-codec";
import type { MemoryFileRecord } from "../../../src/memory/io/frontmatter-schema";
import { MemoryFileIngestor } from "../../../src/memory/io/memory-file-ingestor";
import { MemoryFileWatcher } from "../../../src/memory/io/memory-file-watcher";
import {
  SqliteMemoryDb,
  SqliteMemoryRepository,
  type CreateMemoryInput,
} from "../../../src/memory/storage";

interface TestContext {
  rootDir: string;
  dataDir: string;
  quarantineDir: string;
  memoryDb: SqliteMemoryDb;
  repository: SqliteMemoryRepository;
  ingestor: MemoryFileIngestor;
}

const contexts: TestContext[] = [];

async function createTestContext(prefix: string): Promise<TestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const dbPath = join(rootDir, "memory.db");
  const dataDir = join(rootDir, "memory-files");
  const quarantineDir = join(dataDir, ".quarantine");

  await mkdir(dataDir, { recursive: true });

  const memoryDb = new SqliteMemoryDb({ dbPath });
  const initResult = memoryDb.initialize();
  expect(initResult.ok).toBe(true);
  if (!initResult.ok) throw initResult.error;

  const repository = new SqliteMemoryRepository({
    db: memoryDb,
    dataDir,
  });

  const ingestor = new MemoryFileIngestor({
    repository,
    codec: { parse },
    quarantineDir,
  });

  const context: TestContext = {
    rootDir,
    dataDir,
    quarantineDir,
    memoryDb,
    repository,
    ingestor,
  };

  contexts.push(context);
  return context;
}

function createValidMemoryFile(overrides?: Partial<MemoryFileRecord>): MemoryFileRecord {
  return {
    id: "test-memory-" + Math.random().toString(36).slice(2, 10),
    version: 1,
    type: "fact",
    layer: "stm",
    importance: 0.7,
    confidence: 0.9,
    tags: ["test"],
    entities: ["user"],
    source: {
      type: "explicit",
      conversationId: "conv_test123",
    },
    supersedes: null,
    supersededBy: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    accessedAt: new Date().toISOString(),
    content: "This is a test memory for ingestion.",
    ...overrides,
  };
}

function createInput(overrides?: Partial<CreateMemoryInput>): CreateMemoryInput {
  return {
    content: "Pre-existing memory content.",
    type: "preference",
    layer: "stm",
    importance: 0.6,
    confidence: 0.85,
    tags: ["existing"],
    entities: ["user"],
    source: {
      type: "explicit",
      conversationId: "conv_existing",
    },
    ...overrides,
  };
}

afterEach(async () => {
  for (const ctx of contexts) {
    try {
      ctx.memoryDb.close();
    } catch {
      // ignore
    }
    try {
      await rm(ctx.rootDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  contexts.length = 0;
});

// --- MemoryFileIngestor Tests ---

describe("MemoryFileIngestor", () => {
  describe("ingestFile", () => {
    test("ingests a valid memory file and creates a DB record", async () => {
      const ctx = await createTestContext("ingest-create-");
      const record = createValidMemoryFile();
      const markdown = serialize(record);
      const filePath = join(ctx.dataDir, "test-memory.md");
      await writeFile(filePath, markdown, "utf8");

      const result = await ctx.ingestor.ingestFile(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("created");
      expect(result.value.memoryId).toBeDefined();

      // Verify DB record was created
      const countResult = await ctx.repository.count();
      expect(countResult.ok).toBe(true);
      if (countResult.ok) {
        expect(countResult.value).toBe(1);
      }
    });

    test("updates an existing DB record when file content changes", async () => {
      const ctx = await createTestContext("ingest-update-");

      // Create a memory via repository first
      const createResult = await ctx.repository.create(createInput({
        content: "Original content before edit.",
      }));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const memoryId = createResult.value.id;

      // Write a modified file with the same ID
      const modifiedRecord = createValidMemoryFile({
        id: memoryId,
        type: createResult.value.type,
        layer: createResult.value.layer,
        content: "Updated content after user edit.",
        importance: 0.8,
        source: {
          type: createResult.value.provenance.sourceType,
          conversationId: createResult.value.provenance.conversationId,
        },
        createdAt: createResult.value.createdAt.toISOString(),
        updatedAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
      });

      const markdown = serialize(modifiedRecord);
      const filePath = join(ctx.dataDir, "modified-memory.md");
      await writeFile(filePath, markdown, "utf8");

      const result = await ctx.ingestor.ingestFile(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("updated");
      expect(result.value.memoryId).toBe(memoryId);

      // Verify content was updated in DB
      const getResult = await ctx.repository.getById(memoryId);
      expect(getResult.ok).toBe(true);
      if (getResult.ok && getResult.value) {
        expect(getResult.value.content).toBe("Updated content after user edit.");
        expect(getResult.value.importance).toBe(0.8);
      }
    });

    test("skips ingestion when file content matches DB record", async () => {
      const ctx = await createTestContext("ingest-skip-");

      const createResult = await ctx.repository.create(createInput({
        content: "Unchanged content.",
        importance: 0.6,
        confidence: 0.85,
        tags: ["existing"],
        entities: ["user"],
      }));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const memoryId = createResult.value.id;

      // Write a file with identical content
      const sameRecord = createValidMemoryFile({
        id: memoryId,
        type: createResult.value.type,
        layer: createResult.value.layer,
        content: "Unchanged content.",
        importance: 0.6,
        confidence: 0.85,
        tags: ["existing"],
        entities: ["user"],
        source: {
          type: createResult.value.provenance.sourceType,
          conversationId: createResult.value.provenance.conversationId,
        },
        createdAt: createResult.value.createdAt.toISOString(),
        updatedAt: createResult.value.updatedAt.toISOString(),
        accessedAt: createResult.value.accessedAt.toISOString(),
      });

      const markdown = serialize(sameRecord);
      const filePath = join(ctx.dataDir, "same-memory.md");
      await writeFile(filePath, markdown, "utf8");

      const result = await ctx.ingestor.ingestFile(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("skipped");
      expect(result.value.reason).toBe("No changes detected");
    });

    test("quarantines a file with invalid frontmatter", async () => {
      const ctx = await createTestContext("ingest-quarantine-");
      const filePath = join(ctx.dataDir, "bad-memory.md");
      await writeFile(filePath, "---\ninvalid: yaml: content\n---\n\nSome body.\n", "utf8");

      const result = await ctx.ingestor.ingestFile(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("quarantined");
      expect(result.value.reason).toBeDefined();

      // Verify file was moved to quarantine
      const quarantineFiles = await readdir(ctx.quarantineDir);
      expect(quarantineFiles).toContain("bad-memory.md");
      expect(quarantineFiles).toContain("bad-memory.md.error");

      // Verify error file has details
      const errorContent = await readFile(join(ctx.quarantineDir, "bad-memory.md.error"), "utf8");
      expect(errorContent).toContain("Parse error:");
      expect(errorContent).toContain("Quarantined at:");
    });

    test("quarantines a file without frontmatter delimiters", async () => {
      const ctx = await createTestContext("ingest-no-frontmatter-");
      const filePath = join(ctx.dataDir, "plain.md");
      await writeFile(filePath, "# Just a plain markdown file\n\nNo frontmatter here.\n", "utf8");

      const result = await ctx.ingestor.ingestFile(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.action).toBe("quarantined");

      // Original file should be gone from dataDir
      const dataFiles = await readdir(ctx.dataDir);
      expect(dataFiles).not.toContain("plain.md");
    });

    test("returns error when file does not exist", async () => {
      const ctx = await createTestContext("ingest-missing-");
      const result = await ctx.ingestor.ingestFile(join(ctx.dataDir, "nonexistent.md"));

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("MEMORY_INGEST_ERROR");
      }
    });
  });

  describe("handleDeletion", () => {
    test("reports deletion without removing DB record", async () => {
      const ctx = await createTestContext("ingest-delete-");

      const createResult = await ctx.repository.create(createInput());
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await ctx.ingestor.handleDeletion(join(ctx.dataDir, "some-file.md"));

      expect(result.ok).toBe(true);

      // DB record should still exist
      const countResult = await ctx.repository.count();
      expect(countResult.ok).toBe(true);
      if (countResult.ok) {
        expect(countResult.value).toBe(1);
      }
    });
  });

  describe("scanDirectory", () => {
    test("processes all markdown files in directory", async () => {
      const ctx = await createTestContext("ingest-scan-");

      // Write multiple valid memory files
      for (let i = 0; i < 3; i++) {
        const record = createValidMemoryFile({
          content: `Memory content number ${i}`,
        });
        const markdown = serialize(record);
        await writeFile(join(ctx.dataDir, `memory-${i}.md`), markdown, "utf8");
      }

      const result = await ctx.ingestor.scanDirectory(ctx.dataDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalFiles).toBe(3);
      expect(result.value.ingested).toBe(3);
      expect(result.value.updated).toBe(0);
      expect(result.value.skipped).toBe(0);
      expect(result.value.quarantined).toBe(0);
      expect(result.value.errors).toHaveLength(0);
    });

    test("handles mix of valid and invalid files", async () => {
      const ctx = await createTestContext("ingest-scan-mixed-");

      // Write one valid file
      const validRecord = createValidMemoryFile();
      await writeFile(
        join(ctx.dataDir, "valid.md"),
        serialize(validRecord),
        "utf8",
      );

      // Write one invalid file
      await writeFile(
        join(ctx.dataDir, "invalid.md"),
        "---\nbad: frontmatter\n---\n\nContent.\n",
        "utf8",
      );

      const result = await ctx.ingestor.scanDirectory(ctx.dataDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalFiles).toBe(2);
      expect(result.value.ingested).toBe(1);
      expect(result.value.quarantined).toBe(1);
    });

    test("returns empty report for nonexistent directory", async () => {
      const ctx = await createTestContext("ingest-scan-empty-");
      const result = await ctx.ingestor.scanDirectory(join(ctx.rootDir, "nonexistent"));

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalFiles).toBe(0);
    });

    test("ignores non-markdown files", async () => {
      const ctx = await createTestContext("ingest-scan-filter-");

      // Write a valid memory file
      const record = createValidMemoryFile();
      await writeFile(join(ctx.dataDir, "memory.md"), serialize(record), "utf8");

      // Write non-markdown files
      await writeFile(join(ctx.dataDir, "notes.txt"), "plain text", "utf8");
      await writeFile(join(ctx.dataDir, "data.json"), "{}", "utf8");

      const result = await ctx.ingestor.scanDirectory(ctx.dataDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.totalFiles).toBe(1);
      expect(result.value.ingested).toBe(1);
    });

    test("reports updated count for changed existing records", async () => {
      const ctx = await createTestContext("ingest-scan-update-");

      // Create a memory via repository
      const createResult = await ctx.repository.create(createInput({
        content: "Original scan content.",
      }));
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Write a file with modified content for the same ID
      const modifiedRecord = createValidMemoryFile({
        id: createResult.value.id,
        type: createResult.value.type,
        layer: createResult.value.layer,
        content: "Modified scan content.",
        source: {
          type: createResult.value.provenance.sourceType,
          conversationId: createResult.value.provenance.conversationId,
        },
        createdAt: createResult.value.createdAt.toISOString(),
        updatedAt: new Date().toISOString(),
        accessedAt: new Date().toISOString(),
      });

      await writeFile(
        join(ctx.dataDir, "existing.md"),
        serialize(modifiedRecord),
        "utf8",
      );

      const result = await ctx.ingestor.scanDirectory(ctx.dataDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // totalFiles counts only .md files in the scan directory, not the repo-managed files
      expect(result.value.updated).toBe(1);
    });
  });
});

// --- MemoryFileWatcher Tests ---

describe("MemoryFileWatcher", () => {
  test("starts and stops without error", async () => {
    const ctx = await createTestContext("watcher-lifecycle-");
    const watcher = new MemoryFileWatcher({
      dataDir: ctx.dataDir,
      ingestor: ctx.ingestor,
      debounceMs: 50,
    });

    expect(watcher.isRunning).toBe(false);

    const startResult = await watcher.start();
    expect(startResult.ok).toBe(true);
    expect(watcher.isRunning).toBe(true);

    const stopResult = await watcher.stop();
    expect(stopResult.ok).toBe(true);
    expect(watcher.isRunning).toBe(false);
  });

  test("start is idempotent", async () => {
    const ctx = await createTestContext("watcher-idempotent-");
    const watcher = new MemoryFileWatcher({
      dataDir: ctx.dataDir,
      ingestor: ctx.ingestor,
      debounceMs: 50,
    });

    const first = await watcher.start();
    expect(first.ok).toBe(true);

    const second = await watcher.start();
    expect(second.ok).toBe(true);

    await watcher.stop();
  });

  test("stop is idempotent", async () => {
    const ctx = await createTestContext("watcher-stop-idempotent-");
    const watcher = new MemoryFileWatcher({
      dataDir: ctx.dataDir,
      ingestor: ctx.ingestor,
      debounceMs: 50,
    });

    const result = await watcher.stop();
    expect(result.ok).toBe(true);
  });

  test("returns error when data directory does not exist", async () => {
    const ctx = await createTestContext("watcher-nodir-");
    const watcher = new MemoryFileWatcher({
      dataDir: join(ctx.rootDir, "nonexistent"),
      ingestor: ctx.ingestor,
      debounceMs: 50,
    });

    const result = await watcher.start();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("MEMORY_WATCHER_ERROR");
    }
  });

  test("rescan processes all files in data directory", async () => {
    const ctx = await createTestContext("watcher-rescan-");

    // Write memory files
    for (let i = 0; i < 2; i++) {
      const record = createValidMemoryFile({
        content: `Rescan memory ${i}`,
      });
      await writeFile(join(ctx.dataDir, `rescan-${i}.md`), serialize(record), "utf8");
    }

    const watcher = new MemoryFileWatcher({
      dataDir: ctx.dataDir,
      ingestor: ctx.ingestor,
      debounceMs: 50,
    });

    const result = await watcher.rescan();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.totalFiles).toBe(2);
    expect(result.value.ingested).toBe(2);
  });

  test("debounces rapid file changes", async () => {
    const ctx = await createTestContext("watcher-debounce-");

    let ingestCallCount = 0;
    const trackingIngestor = new MemoryFileIngestor({
      repository: ctx.repository,
      codec: { parse },
      quarantineDir: ctx.quarantineDir,
    });

    const originalIngest = trackingIngestor.ingestFile.bind(trackingIngestor);
    trackingIngestor.ingestFile = async (filePath: string) => {
      ingestCallCount++;
      return originalIngest(filePath);
    };

    const watcher = new MemoryFileWatcher({
      dataDir: ctx.dataDir,
      ingestor: trackingIngestor,
      debounceMs: 100,
    });

    await watcher.start();

    // Write the same file rapidly multiple times
    const record = createValidMemoryFile({ content: "Rapid edit 1" });
    const filePath = join(ctx.dataDir, "rapid.md");

    await writeFile(filePath, serialize(record), "utf8");
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(filePath, serialize({ ...record, content: "Rapid edit 2" }), "utf8");
    await new Promise((r) => setTimeout(r, 20));
    await writeFile(filePath, serialize({ ...record, content: "Rapid edit 3" }), "utf8");

    // Wait for debounce to settle
    await new Promise((r) => setTimeout(r, 300));

    await watcher.stop();

    // Should have been called fewer times than the number of writes
    // due to debouncing (ideally once, but timing can vary)
    expect(ingestCallCount).toBeLessThanOrEqual(2);
  });

  test("detects and ingests new file written while watching", async () => {
    const ctx = await createTestContext("watcher-detect-");

    const watcher = new MemoryFileWatcher({
      dataDir: ctx.dataDir,
      ingestor: ctx.ingestor,
      debounceMs: 50,
    });

    await watcher.start();

    // Write a new memory file
    const record = createValidMemoryFile({ content: "Watched file content" });
    await writeFile(join(ctx.dataDir, "watched.md"), serialize(record), "utf8");

    // Wait for debounce + processing
    await new Promise((r) => setTimeout(r, 200));

    await watcher.stop();

    // Verify the memory was ingested
    const countResult = await ctx.repository.count();
    expect(countResult.ok).toBe(true);
    if (countResult.ok) {
      expect(countResult.value).toBe(1);
    }
  });

  test("ignores non-markdown files during watch", async () => {
    const ctx = await createTestContext("watcher-ignore-nonmd-");

    const watcher = new MemoryFileWatcher({
      dataDir: ctx.dataDir,
      ingestor: ctx.ingestor,
      debounceMs: 50,
    });

    await watcher.start();

    // Write non-markdown files
    await writeFile(join(ctx.dataDir, "notes.txt"), "plain text", "utf8");
    await writeFile(join(ctx.dataDir, "data.json"), "{}", "utf8");

    // Wait for any potential processing
    await new Promise((r) => setTimeout(r, 200));

    await watcher.stop();

    // No memories should have been created
    const countResult = await ctx.repository.count();
    expect(countResult.ok).toBe(true);
    if (countResult.ok) {
      expect(countResult.value).toBe(0);
    }
  });

  test("ignores temporary files during watch", async () => {
    const ctx = await createTestContext("watcher-ignore-tmp-");

    const watcher = new MemoryFileWatcher({
      dataDir: ctx.dataDir,
      ingestor: ctx.ingestor,
      debounceMs: 50,
    });

    await watcher.start();

    // Write temp/swap files
    await writeFile(join(ctx.dataDir, ".hidden.md"), "hidden", "utf8");
    await writeFile(join(ctx.dataDir, "~backup.md"), "backup", "utf8");
    await writeFile(join(ctx.dataDir, "#autosave.md"), "autosave", "utf8");

    // Wait for any potential processing
    await new Promise((r) => setTimeout(r, 200));

    await watcher.stop();

    // No memories should have been created
    const countResult = await ctx.repository.count();
    expect(countResult.ok).toBe(true);
    if (countResult.ok) {
      expect(countResult.value).toBe(0);
    }
  });

  test("handles file deletion gracefully", async () => {
    const ctx = await createTestContext("watcher-deletion-");

    // Create a memory and its file
    const createResult = await ctx.repository.create(createInput());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) return;

    const watcher = new MemoryFileWatcher({
      dataDir: ctx.dataDir,
      ingestor: ctx.ingestor,
      debounceMs: 50,
    });

    await watcher.start();

    // Delete a markdown file from the data directory
    const files = await readdir(ctx.dataDir);
    const mdFile = files.find((f) => f.endsWith(".md"));
    if (mdFile) {
      const { unlink } = await import("node:fs/promises");
      await unlink(join(ctx.dataDir, mdFile));
    }

    // Wait for processing
    await new Promise((r) => setTimeout(r, 200));

    await watcher.stop();

    // DB record should still exist (no auto-delete)
    const countResult = await ctx.repository.count();
    expect(countResult.ok).toBe(true);
    if (countResult.ok) {
      expect(countResult.value).toBe(1);
    }
  });
});
