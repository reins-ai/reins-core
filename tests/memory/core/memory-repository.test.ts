import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse, serialize, type MemoryFileRecord } from "../../../src/memory/io/index";
import {
  SqliteMemoryDb,
  SqliteMemoryRepository,
  type CreateMemoryInput,
} from "../../../src/memory/storage";

interface TestContext {
  rootDir: string;
  dataDir: string;
  memoryDb: SqliteMemoryDb;
  repository: SqliteMemoryRepository;
}

const contexts: TestContext[] = [];

async function createTestContext(prefix: string): Promise<TestContext> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix));
  const dbPath = join(rootDir, "memory.db");
  const dataDir = join(rootDir, "memory-files");

  await mkdir(dataDir, { recursive: true });

  const memoryDb = new SqliteMemoryDb({ dbPath });
  const initResult = memoryDb.initialize();
  expect(initResult.ok).toBe(true);
  if (!initResult.ok) {
    throw initResult.error;
  }

  const repository = new SqliteMemoryRepository({
    db: memoryDb,
    dataDir,
  });

  const context: TestContext = {
    rootDir,
    dataDir,
    memoryDb,
    repository,
  };

  contexts.push(context);
  return context;
}

async function findFilePathByMemoryId(dataDir: string, id: string): Promise<string | null> {
  const names = await readdir(dataDir);
  for (const name of names) {
    if (!name.endsWith(".md")) {
      continue;
    }

    const filePath = join(dataDir, name);
    const markdown = await readFile(filePath, "utf8");
    const parsed = parse(markdown);
    if (parsed.ok && parsed.value.id === id) {
      return filePath;
    }
  }

  return null;
}

function createInput(overrides?: Partial<CreateMemoryInput>): CreateMemoryInput {
  return {
    content: "User prefers concise test output.",
    type: "preference",
    layer: "stm",
    importance: 0.62,
    confidence: 0.88,
    tags: ["testing", "style"],
    entities: ["user"],
    source: {
      type: "explicit",
      conversationId: "conv_123",
      messageId: "msg_123",
    },
    ...overrides,
  };
}

function createOrphanFileRecord(id: string): MemoryFileRecord {
  return {
    id,
    version: 1,
    type: "fact",
    layer: "stm",
    importance: 0.7,
    confidence: 1,
    tags: ["orphan"],
    entities: ["system"],
    source: {
      type: "explicit",
      conversationId: "conv_orphan",
      messageId: "msg_orphan",
    },
    supersedes: null,
    supersededBy: null,
    createdAt: "2026-02-13T21:15:00.000Z",
    updatedAt: "2026-02-13T21:15:00.000Z",
    accessedAt: "2026-02-13T21:15:00.000Z",
    content: "Orphan memory file content.",
  };
}

describe("SqliteMemoryRepository", () => {
  beforeEach(() => {
    contexts.length = 0;
  });

  afterEach(async () => {
    for (const context of contexts) {
      context.memoryDb.close();
      await rm(context.rootDir, { recursive: true, force: true });
    }
  });

  test("creates memory in DB and markdown file", async () => {
    const context = await createTestContext("reins-memory-repo-");
    const createResult = await context.repository.create(createInput());

    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }

    const created = createResult.value;
    expect(created.layer).toBe("stm");
    expect(created.type).toBe("preference");

    const db = context.memoryDb.getDb();
    const dbRow = db
      .query("SELECT id, content, source_type FROM memories WHERE id = ?1")
      .get(created.id) as { id: string; content: string; source_type: string } | null;
    expect(dbRow?.id).toBe(created.id);
    expect(dbRow?.content).toBe("User prefers concise test output.");
    expect(dbRow?.source_type).toBe("explicit");

    const filePath = await findFilePathByMemoryId(context.dataDir, created.id);
    expect(filePath).not.toBeNull();
    const markdown = await readFile(filePath!, "utf8");
    const parsed = parse(markdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.value.id).toBe(created.id);
    expect(parsed.value.content).toBe(created.content);
    expect(parsed.value.source.messageId).toBe("msg_123");

    const provenanceRow = db
      .query(
        "SELECT source_details FROM memory_provenance WHERE memory_id = ?1 AND event_type = 'created' LIMIT 1",
      )
      .get(created.id) as { source_details: string } | null;
    expect(provenanceRow).not.toBeNull();
    expect(provenanceRow?.source_details).toContain("checksum");
    expect(provenanceRow?.source_details).toContain("fileName");
  });

  test("gets memory by id", async () => {
    const context = await createTestContext("reins-memory-repo-");
    const createResult = await context.repository.create(createInput({ type: "fact" }));
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }

    const getResult = await context.repository.getById(createResult.value.id);
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) {
      return;
    }

    expect(getResult.value?.id).toBe(createResult.value.id);
    expect(getResult.value?.type).toBe("fact");

    const missing = await context.repository.getById("missing-memory");
    expect(missing.ok).toBe(true);
    if (!missing.ok) {
      return;
    }

    expect(missing.value).toBeNull();
  });

  test("updates memory in DB and markdown file", async () => {
    const context = await createTestContext("reins-memory-repo-");
    const createResult = await context.repository.create(createInput());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }

    const updateResult = await context.repository.update(createResult.value.id, {
      content: "User prefers strict TypeScript with no implicit any.",
      tags: ["typescript", "strict"],
      importance: 0.95,
    });
    expect(updateResult.ok).toBe(true);
    if (!updateResult.ok) {
      return;
    }

    const db = context.memoryDb.getDb();
    const row = db
      .query("SELECT content, importance, tags FROM memories WHERE id = ?1")
      .get(createResult.value.id) as { content: string; importance: number; tags: string } | null;
    expect(row?.content).toBe("User prefers strict TypeScript with no implicit any.");
    expect(row?.importance).toBe(0.95);
    expect(row?.tags).toContain("typescript");

    const filePath = await findFilePathByMemoryId(context.dataDir, createResult.value.id);
    expect(filePath).not.toBeNull();

    const markdown = await readFile(filePath!, "utf8");
    const parsed = parse(markdown);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.value.content).toBe("User prefers strict TypeScript with no implicit any.");
    expect(parsed.value.tags).toEqual(["typescript", "strict"]);

    const provenanceCount = db
      .query("SELECT COUNT(*) as count FROM memory_provenance WHERE memory_id = ?1")
      .get(createResult.value.id) as { count: number };
    expect(provenanceCount.count).toBe(2);
  });

  test("deletes memory from DB and markdown file", async () => {
    const context = await createTestContext("reins-memory-repo-");
    const createResult = await context.repository.create(createInput());
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }

    const filePath = await findFilePathByMemoryId(context.dataDir, createResult.value.id);
    expect(filePath).not.toBeNull();

    const deleteResult = await context.repository.delete(createResult.value.id);
    expect(deleteResult.ok).toBe(true);

    const db = context.memoryDb.getDb();
    const row = db.query("SELECT id FROM memories WHERE id = ?1").get(createResult.value.id) as { id: string } | null;
    expect(row).toBeNull();

    const files = await readdir(context.dataDir);
    expect(files.length).toBe(0);

    const deletedGet = await context.repository.getById(createResult.value.id);
    expect(deletedGet.ok).toBe(true);
    if (!deletedGet.ok) {
      return;
    }

    expect(deletedGet.value).toBeNull();
  });

  test("lists memories with type and layer filtering", async () => {
    const context = await createTestContext("reins-memory-repo-");

    const first = await context.repository.create(createInput({ type: "fact", layer: "stm" }));
    const second = await context.repository.create(createInput({ type: "preference", layer: "ltm" }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }

    const listed = await context.repository.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    expect(listed.value.length).toBe(2);

    const byType = await context.repository.findByType("fact");
    expect(byType.ok).toBe(true);
    if (!byType.ok) {
      return;
    }
    expect(byType.value.length).toBe(1);
    expect(byType.value[0]?.id).toBe(first.value.id);

    const byLayer = await context.repository.findByLayer("ltm");
    expect(byLayer.ok).toBe(true);
    if (!byLayer.ok) {
      return;
    }
    expect(byLayer.value.length).toBe(1);
    expect(byLayer.value[0]?.id).toBe(second.value.id);
  });

  test("reconcile reports orphaned files, missing files, and content mismatches", async () => {
    const context = await createTestContext("reins-memory-repo-");
    const first = await context.repository.create(createInput({ content: "Original content A" }));
    const second = await context.repository.create(createInput({ content: "Original content B" }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) {
      return;
    }

    const firstFile = await findFilePathByMemoryId(context.dataDir, first.value.id);
    const secondFile = await findFilePathByMemoryId(context.dataDir, second.value.id);
    expect(firstFile).not.toBeNull();
    expect(secondFile).not.toBeNull();

    const firstFileContent = await readFile(firstFile!, "utf8");
    const parsedFirst = parse(firstFileContent);
    expect(parsedFirst.ok).toBe(true);
    if (!parsedFirst.ok) {
      return;
    }

    const tampered: MemoryFileRecord = {
      ...parsedFirst.value,
      content: "Tampered file content",
      updatedAt: "2026-02-14T00:00:00.000Z",
    };
    await writeFile(firstFile!, serialize(tampered), "utf8");
    await unlink(secondFile!);

    const orphanFileName = "2026-02-13T21-15-00_fact_ORPHAN1.md";
    await writeFile(
      join(context.dataDir, orphanFileName),
      serialize(createOrphanFileRecord("orphan-memory-id")),
      "utf8",
    );

    const reconciliation = await context.repository.reconcile();
    expect(reconciliation.ok).toBe(true);
    if (!reconciliation.ok) {
      return;
    }

    expect(reconciliation.value.isConsistent).toBe(false);
    expect(reconciliation.value.missingFiles).toContain(second.value.id);
    expect(reconciliation.value.contentMismatches).toContain(first.value.id);
    expect(reconciliation.value.orphanedFiles).toContain(orphanFileName);
  });

  test("rolls back DB write when file write fails", async () => {
    const context = await createTestContext("reins-memory-repo-");

    await chmod(context.dataDir, 0o500);
    try {
      const createResult = await context.repository.create(createInput({ content: "Will fail" }));
      expect(createResult.ok).toBe(false);

      const countResult = await context.repository.count();
      expect(countResult.ok).toBe(true);
      if (!countResult.ok) {
        return;
      }

      expect(countResult.value).toBe(0);

      const db = context.memoryDb.getDb();
      const row = db.query("SELECT COUNT(*) as count FROM memories").get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      await chmod(context.dataDir, 0o700);
    }
  });

  test("supports markdown round-trip parity after create", async () => {
    const context = await createTestContext("reins-memory-repo-");
    const createResult = await context.repository.create(
      createInput({
        content: "First line.\n\nSecond line with detail.",
        type: "decision",
        source: {
          type: "implicit",
          conversationId: "conv_roundtrip",
          messageId: "msg_roundtrip",
        },
      }),
    );
    expect(createResult.ok).toBe(true);
    if (!createResult.ok) {
      return;
    }

    const filePath = await findFilePathByMemoryId(context.dataDir, createResult.value.id);
    expect(filePath).not.toBeNull();
    const markdown = await readFile(filePath!, "utf8");
    const parsed = parse(markdown);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }

    expect(parsed.value.id).toBe(createResult.value.id);
    expect(parsed.value.type).toBe("decision");
    expect(parsed.value.content).toBe("First line.\n\nSecond line with detail.");
    expect(parsed.value.source.type).toBe("implicit");
    expect(parsed.value.source.messageId).toBe("msg_roundtrip");
  });
});
