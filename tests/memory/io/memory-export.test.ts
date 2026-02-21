import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { MemoryRecord } from "../../../src/memory/types/memory-record";
import type { MemoryRepository } from "../../../src/memory/storage/memory-repository";
import { ok, err } from "../../../src/result";
import { MemoryError } from "../../../src/memory/services/memory-error";
import {
  exportMemories,
  type MemoryExportFile,
} from "../../../src/memory/io/memory-export";

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: overrides.id ?? "mem-1",
    content: overrides.content ?? "test memory content",
    type: overrides.type ?? "fact",
    layer: overrides.layer ?? "ltm",
    tags: overrides.tags ?? ["tag1"],
    entities: overrides.entities ?? ["entity1"],
    importance: overrides.importance ?? 0.8,
    confidence: overrides.confidence ?? 0.9,
    provenance: overrides.provenance ?? { sourceType: "explicit" },
    supersedes: overrides.supersedes,
    supersededBy: overrides.supersededBy,
    embedding: overrides.embedding,
    createdAt: overrides.createdAt ?? new Date("2026-02-20T10:00:00.000Z"),
    updatedAt: overrides.updatedAt ?? new Date("2026-02-20T11:00:00.000Z"),
    accessedAt: overrides.accessedAt ?? new Date("2026-02-20T12:00:00.000Z"),
  };
}

function makeMockRepository(records: MemoryRecord[]): MemoryRepository {
  return {
    list: async () => ok(records),
    create: async () => ok(records[0]!),
    getById: async () => ok(null),
    update: async () => ok(records[0]!),
    delete: async () => ok(undefined),
    findByType: async () => ok([]),
    findByLayer: async () => ok([]),
    count: async () => ok(records.length),
    reconcile: async () =>
      ok({
        totalFiles: 0,
        totalDbRecords: 0,
        orphanedFiles: [],
        missingFiles: [],
        contentMismatches: [],
        isConsistent: true,
      }),
  };
}

describe("exportMemories", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-export-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("exports valid JSON file at specified path", async () => {
    const records = [makeRecord()];
    const repo = makeMockRepository(records);
    const outputPath = join(tempDir, "export.json");

    const result = await exportMemories(repo, outputPath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryExportFile;
    expect(parsed).toBeDefined();
    expect(typeof parsed).toBe("object");
  });

  it("includes version field set to 1.0", async () => {
    const repo = makeMockRepository([makeRecord()]);
    const outputPath = join(tempDir, "export.json");

    await exportMemories(repo, outputPath);

    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryExportFile;
    expect(parsed.version).toBe("1.0");
  });

  it("includes exportedAt as a valid ISO date string", async () => {
    const repo = makeMockRepository([makeRecord()]);
    const outputPath = join(tempDir, "export.json");

    const result = await exportMemories(repo, outputPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryExportFile;

    const date = new Date(parsed.exportedAt);
    expect(Number.isNaN(date.getTime())).toBe(false);
    expect(parsed.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("includes all MemoryRecord entries with correct count", async () => {
    const records = [
      makeRecord({ id: "mem-1", content: "first" }),
      makeRecord({ id: "mem-2", content: "second", type: "preference" }),
      makeRecord({ id: "mem-3", content: "third", type: "decision" }),
    ];
    const repo = makeMockRepository(records);
    const outputPath = join(tempDir, "export.json");

    const result = await exportMemories(repo, outputPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.count).toBe(3);

    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryExportFile;
    expect(parsed.memories).toHaveLength(3);
    expect(parsed.memories[0]!.id).toBe("mem-1");
    expect(parsed.memories[1]!.id).toBe("mem-2");
    expect(parsed.memories[2]!.id).toBe("mem-3");
  });

  it("serializes dates as ISO strings, not Date objects", async () => {
    const record = makeRecord({
      createdAt: new Date("2026-01-15T08:30:00.000Z"),
      updatedAt: new Date("2026-01-16T09:45:00.000Z"),
      accessedAt: new Date("2026-01-17T10:00:00.000Z"),
    });
    const repo = makeMockRepository([record]);
    const outputPath = join(tempDir, "export.json");

    await exportMemories(repo, outputPath);

    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryExportFile;
    const exported = parsed.memories[0]!;

    expect(exported.createdAt).toBe("2026-01-15T08:30:00.000Z");
    expect(exported.updatedAt).toBe("2026-01-16T09:45:00.000Z");
    expect(exported.accessedAt).toBe("2026-01-17T10:00:00.000Z");
    expect(typeof exported.createdAt).toBe("string");
    expect(typeof exported.updatedAt).toBe("string");
    expect(typeof exported.accessedAt).toBe("string");
  });

  it("omits embedding field from exported records", async () => {
    const record = makeRecord({
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
        dimension: 1536,
        version: "1.0",
      },
    });
    const repo = makeMockRepository([record]);
    const outputPath = join(tempDir, "export.json");

    await exportMemories(repo, outputPath);

    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryExportFile;
    const exported = parsed.memories[0]!;

    expect("embedding" in exported).toBe(false);
    expect((exported as Record<string, unknown>)["embedding"]).toBeUndefined();
  });

  it("returns ExportResult with correct path, count, and exportedAt", async () => {
    const records = [
      makeRecord({ id: "mem-1" }),
      makeRecord({ id: "mem-2" }),
    ];
    const repo = makeMockRepository(records);
    const outputPath = join(tempDir, "export.json");

    const result = await exportMemories(repo, outputPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.path).toBe(outputPath);
    expect(result.value.count).toBe(2);
    expect(typeof result.value.exportedAt).toBe("string");

    const date = new Date(result.value.exportedAt);
    expect(Number.isNaN(date.getTime())).toBe(false);
  });

  it("exports empty memories array for empty repository", async () => {
    const repo = makeMockRepository([]);
    const outputPath = join(tempDir, "export.json");

    const result = await exportMemories(repo, outputPath);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.count).toBe(0);

    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryExportFile;
    expect(parsed.version).toBe("1.0");
    expect(parsed.memories).toEqual([]);
    expect(typeof parsed.exportedAt).toBe("string");
  });

  it("returns err(MemoryError) when file write fails", async () => {
    const repo = makeMockRepository([makeRecord()]);
    const invalidPath = "/nonexistent-root-dir/deeply/nested/export.json";

    const result = await exportMemories(repo, invalidPath);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_EXPORT_FAILED");
  });

  it("returns err(MemoryError) when repository.list() fails", async () => {
    const repoError = new MemoryError("DB connection lost", "MEMORY_DB_ERROR");
    const repo: MemoryRepository = {
      ...makeMockRepository([]),
      list: async () => err(repoError),
    };
    const outputPath = join(tempDir, "export.json");

    const result = await exportMemories(repo, outputPath);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_EXPORT_FAILED");
    expect(result.error.message).toContain("Failed to read memories");
  });

  it("preserves all non-embedding fields in exported records", async () => {
    const record = makeRecord({
      id: "mem-full",
      content: "full record test",
      type: "skill",
      layer: "stm",
      tags: ["alpha", "beta"],
      entities: ["person-1"],
      importance: 0.95,
      confidence: 0.7,
      provenance: { sourceType: "implicit", conversationId: "conv-123" },
      supersedes: "mem-old",
      supersededBy: "mem-new",
    });
    const repo = makeMockRepository([record]);
    const outputPath = join(tempDir, "export.json");

    await exportMemories(repo, outputPath);

    const raw = await readFile(outputPath, "utf8");
    const parsed = JSON.parse(raw) as MemoryExportFile;
    const exported = parsed.memories[0]!;

    expect(exported.id).toBe("mem-full");
    expect(exported.content).toBe("full record test");
    expect(exported.type).toBe("skill");
    expect(exported.layer).toBe("stm");
    expect(exported.tags).toEqual(["alpha", "beta"]);
    expect(exported.entities).toEqual(["person-1"]);
    expect(exported.importance).toBe(0.95);
    expect(exported.confidence).toBe(0.7);
    expect(exported.provenance.sourceType).toBe("implicit");
    expect(exported.provenance.conversationId).toBe("conv-123");
    expect(exported.supersedes).toBe("mem-old");
    expect(exported.supersededBy).toBe("mem-new");
  });

  it("writes pretty-printed JSON with 2-space indentation", async () => {
    const repo = makeMockRepository([makeRecord()]);
    const outputPath = join(tempDir, "export.json");

    await exportMemories(repo, outputPath);

    const raw = await readFile(outputPath, "utf8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  ");

    const reparsed = JSON.stringify(JSON.parse(raw), null, 2);
    expect(raw).toBe(reparsed);
  });
});
