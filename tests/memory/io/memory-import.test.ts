import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import type { MemoryRecord } from "../../../src/memory/types/memory-record";
import type { MemoryRepository } from "../../../src/memory/storage/memory-repository";
import type { CreateMemoryInput } from "../../../src/memory/storage/memory-repository";
import { ok, err } from "../../../src/result";
import { MemoryError } from "../../../src/memory/services/memory-error";
import { MemoryIngestError, type ScanReport } from "../../../src/memory/io/memory-file-ingestor";
import {
  importMemoriesFromJson,
  importMemoriesFromDirectory,
  type ImportResult,
} from "../../../src/memory/io/memory-import";
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

function makeExportFile(
  memories: Array<Record<string, unknown>> = [],
  overrides: Partial<MemoryExportFile> = {},
): MemoryExportFile {
  return {
    version: overrides.version ?? "1.0",
    exportedAt: overrides.exportedAt ?? "2026-02-20T10:00:00.000Z",
    memories: memories as MemoryExportFile["memories"],
  };
}

function makeExportedRecord(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "mem-1",
    content: "test memory content",
    type: "fact",
    layer: "ltm",
    importance: 0.8,
    confidence: 0.9,
    tags: ["tag1"],
    entities: ["entity1"],
    provenance: { sourceType: "explicit" },
    createdAt: "2026-02-20T10:00:00.000Z",
    updatedAt: "2026-02-20T11:00:00.000Z",
    accessedAt: "2026-02-20T12:00:00.000Z",
    ...overrides,
  };
}

interface MockRepositoryOptions {
  existingRecords?: MemoryRecord[];
  createFn?: (input: CreateMemoryInput) => Promise<ReturnType<MemoryRepository["create"]>>;
}

function makeMockRepository(options: MockRepositoryOptions = {}): MemoryRepository & { created: CreateMemoryInput[] } {
  const existingRecords = options.existingRecords ?? [];
  const created: CreateMemoryInput[] = [];

  const defaultCreate = async (input: CreateMemoryInput) => {
    created.push(input);
    const record = makeRecord({
      content: input.content,
      type: input.type,
      layer: input.layer ?? "stm",
      importance: input.importance ?? 0.5,
      confidence: input.confidence ?? 1.0,
      tags: input.tags ?? [],
      entities: input.entities ?? [],
      provenance: {
        sourceType: input.source.type,
        conversationId: input.source.conversationId,
      },
      supersedes: input.supersedes,
    });
    return ok(record);
  };

  return {
    created,
    list: async () => ok(existingRecords),
    create: options.createFn ?? defaultCreate,
    getById: async () => ok(null),
    update: async () => ok(existingRecords[0] ?? makeRecord()),
    delete: async () => ok(undefined),
    findByType: async () => ok([]),
    findByLayer: async () => ok([]),
    count: async () => ok(existingRecords.length),
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

async function writeJsonFile(dir: string, fileName: string, data: unknown): Promise<string> {
  const filePath = join(dir, fileName);
  await writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
  return filePath;
}

describe("importMemoriesFromJson", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-import-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("imports all records from a valid JSON file", async () => {
    const records = [
      makeExportedRecord({ id: "mem-1", content: "first memory" }),
      makeExportedRecord({ id: "mem-2", content: "second memory", type: "preference" }),
      makeExportedRecord({ id: "mem-3", content: "third memory", type: "decision" }),
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(3);
    expect(result.value.skipped).toBe(0);
    expect(result.value.errors).toEqual([]);
    expect(repo.created).toHaveLength(3);
  });

  it("round-trips: export then import produces same records in store", async () => {
    const originalRecords = [
      makeRecord({ id: "mem-1", content: "round trip alpha" }),
      makeRecord({ id: "mem-2", content: "round trip beta", type: "preference", importance: 0.6 }),
    ];

    // Export
    const exportRepo = makeMockRepository({ existingRecords: originalRecords });
    const exportPath = join(tempDir, "roundtrip.json");
    const exportResult = await exportMemories(exportRepo, exportPath);
    expect(exportResult.ok).toBe(true);

    // Import into empty repo
    const importRepo = makeMockRepository();
    const importResult = await importMemoriesFromJson(importRepo, exportPath);

    expect(importResult.ok).toBe(true);
    if (!importResult.ok) return;

    expect(importResult.value.imported).toBe(2);
    expect(importResult.value.skipped).toBe(0);
    expect(importResult.value.errors).toEqual([]);

    // Verify content matches
    expect(importRepo.created[0]!.content).toBe("round trip alpha");
    expect(importRepo.created[1]!.content).toBe("round trip beta");
    expect(importRepo.created[1]!.type).toBe("preference");
    expect(importRepo.created[1]!.importance).toBe(0.6);
  });

  it("skips records with duplicate content", async () => {
    const existingRecord = makeRecord({ content: "already exists" });
    const records = [
      makeExportedRecord({ id: "mem-1", content: "already exists" }),
      makeExportedRecord({ id: "mem-2", content: "new content" }),
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository({ existingRecords: [existingRecord] });
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(1);
    expect(result.value.skipped).toBe(1);
    expect(result.value.errors).toEqual([]);
    expect(repo.created).toHaveLength(1);
    expect(repo.created[0]!.content).toBe("new content");
  });

  it("returns err(MemoryError) for invalid JSON", async () => {
    const filePath = join(tempDir, "bad.json");
    await writeFile(filePath, "{ not valid json !!!", "utf8");

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_IMPORT_FAILED");
    expect(result.error.message).toContain("Invalid JSON");
  });

  it("adds error for record with unknown type value", async () => {
    const records = [
      makeExportedRecord({ id: "mem-1", content: "valid", type: "fact" }),
      makeExportedRecord({ id: "mem-2", content: "invalid type", type: "unknown_type" }),
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(1);
    expect(result.value.errors).toHaveLength(1);
    expect(result.value.errors[0]).toContain("Unknown memory type: unknown_type");
  });

  it("adds error for record with missing required fields", async () => {
    const records = [
      { id: "mem-1" }, // missing content, type, importance, tags, dates
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(0);
    expect(result.value.errors).toHaveLength(1);
    expect(result.value.errors[0]).toContain("Record 0");
  });

  it("returns err(MemoryError) when file not found", async () => {
    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, join(tempDir, "nonexistent.json"));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_IMPORT_FAILED");
    expect(result.error.message).toContain("not found");
  });

  it("returns ok with zero counts for empty memories array", async () => {
    const exportFile = makeExportFile([]);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(0);
    expect(result.value.skipped).toBe(0);
    expect(result.value.errors).toEqual([]);
  });

  it("handles mixed valid and invalid records with correct counts", async () => {
    const records = [
      makeExportedRecord({ id: "mem-1", content: "valid one" }),
      makeExportedRecord({ id: "mem-2", content: "invalid type", type: "bogus" }),
      makeExportedRecord({ id: "mem-3", content: "valid two", type: "skill" }),
      { id: "mem-4" }, // missing required fields
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(2);
    expect(result.value.errors).toHaveLength(2);
    expect(repo.created).toHaveLength(2);
  });

  it("returns err(MemoryError) for unsupported version", async () => {
    const exportFile = { version: "2.0", exportedAt: "2026-02-20T10:00:00.000Z", memories: [] };
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_IMPORT_FAILED");
    expect(result.error.message).toContain("version");
  });

  it("detects intra-batch duplicates within the same import file", async () => {
    const records = [
      makeExportedRecord({ id: "mem-1", content: "duplicate content" }),
      makeExportedRecord({ id: "mem-2", content: "duplicate content" }),
      makeExportedRecord({ id: "mem-3", content: "unique content" }),
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(2);
    expect(result.value.skipped).toBe(1);
    expect(repo.created).toHaveLength(2);
  });

  it("continues importing when individual record create fails", async () => {
    let callCount = 0;
    const createFn = async (input: CreateMemoryInput) => {
      callCount++;
      if (callCount === 2) {
        return err(new MemoryError("DB write failed", "MEMORY_DB_ERROR"));
      }
      return ok(makeRecord({ content: input.content }));
    };

    const records = [
      makeExportedRecord({ id: "mem-1", content: "first" }),
      makeExportedRecord({ id: "mem-2", content: "second will fail" }),
      makeExportedRecord({ id: "mem-3", content: "third" }),
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository({ createFn });
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(2);
    expect(result.value.errors).toHaveLength(1);
    expect(result.value.errors[0]).toContain("DB write failed");
  });

  it("preserves provenance fields during import", async () => {
    const records = [
      makeExportedRecord({
        id: "mem-1",
        content: "with provenance",
        provenance: { sourceType: "implicit", conversationId: "conv-abc" },
      }),
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(repo.created[0]!.source.type).toBe("implicit");
    expect(repo.created[0]!.source.conversationId).toBe("conv-abc");
  });

  it("preserves layer, confidence, entities, and supersedes fields", async () => {
    const records = [
      makeExportedRecord({
        id: "mem-1",
        content: "full fields",
        layer: "stm",
        confidence: 0.75,
        entities: ["person-1", "org-2"],
        supersedes: "mem-old",
      }),
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(repo.created[0]!.layer).toBe("stm");
    expect(repo.created[0]!.confidence).toBe(0.75);
    expect(repo.created[0]!.entities).toEqual(["person-1", "org-2"]);
    expect(repo.created[0]!.supersedes).toBe("mem-old");
  });

  it("returns err(MemoryError) when file is not a JSON object", async () => {
    const filePath = join(tempDir, "array.json");
    await writeFile(filePath, JSON.stringify([1, 2, 3]), "utf8");

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_IMPORT_FAILED");
  });

  it("returns err(MemoryError) when memories field is not an array", async () => {
    const filePath = await writeJsonFile(tempDir, "bad-memories.json", {
      version: "1.0",
      exportedAt: "2026-02-20T10:00:00.000Z",
      memories: "not an array",
    });

    const repo = makeMockRepository();
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_IMPORT_FAILED");
  });

  it("duplicate detection is case-sensitive", async () => {
    const existingRecord = makeRecord({ content: "Hello World" });
    const records = [
      makeExportedRecord({ id: "mem-1", content: "hello world" }),
      makeExportedRecord({ id: "mem-2", content: "Hello World" }),
    ];
    const exportFile = makeExportFile(records);
    const filePath = await writeJsonFile(tempDir, "import.json", exportFile);

    const repo = makeMockRepository({ existingRecords: [existingRecord] });
    const result = await importMemoriesFromJson(repo, filePath);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // "hello world" (lowercase) is different from "Hello World" — should import
    // "Hello World" matches existing — should skip
    expect(result.value.imported).toBe(1);
    expect(result.value.skipped).toBe(1);
    expect(repo.created[0]!.content).toBe("hello world");
  });
});

// ---------------------------------------------------------------------------
// Mock MemoryFileIngestor helpers
// ---------------------------------------------------------------------------

type ScanDirectoryFn = (dirPath: string) => Promise<ReturnType<import("../../../src/memory/io/memory-file-ingestor").MemoryFileIngestor["scanDirectory"]>>;

function makeMockIngestor(scanFn: ScanDirectoryFn): import("../../../src/memory/io/memory-file-ingestor").MemoryFileIngestor {
  return {
    scanDirectory: scanFn,
    ingestFile: async () => ok({ action: "skipped" as const }),
    handleDeletion: async () => ok(undefined),
  } as unknown as import("../../../src/memory/io/memory-file-ingestor").MemoryFileIngestor;
}

function makeScanReport(overrides: Partial<ScanReport> = {}): ScanReport {
  return {
    totalFiles: 0,
    ingested: 0,
    updated: 0,
    skipped: 0,
    quarantined: 0,
    errors: [],
    ...overrides,
  };
}

describe("importMemoriesFromDirectory", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-dir-import-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("calls scanDirectory and returns ok(ImportResult) for a valid directory", async () => {
    let capturedPath: string | undefined;
    const ingestor = makeMockIngestor(async (dirPath) => {
      capturedPath = dirPath;
      return ok(makeScanReport({ ingested: 3, updated: 1, skipped: 2, quarantined: 0, errors: [] }));
    });

    const result = await importMemoriesFromDirectory(ingestor, tempDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(capturedPath).toBe(tempDir);
    expect(result.value.imported).toBe(4); // ingested + updated
    expect(result.value.skipped).toBe(2);  // skipped + quarantined
    expect(result.value.errors).toEqual([]);
  });

  it("maps quarantined files into skipped count", async () => {
    const ingestor = makeMockIngestor(async () =>
      ok(makeScanReport({ ingested: 1, updated: 0, skipped: 1, quarantined: 2, errors: [] })),
    );

    const result = await importMemoriesFromDirectory(ingestor, tempDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(1);
    expect(result.value.skipped).toBe(3); // 1 skipped + 2 quarantined
  });

  it("maps scan errors into ImportResult.errors strings", async () => {
    const ingestor = makeMockIngestor(async () =>
      ok(makeScanReport({
        ingested: 1,
        errors: [
          { file: "bad.md", error: "Parse failed" },
          { file: "other.md", error: "Read error" },
        ],
      })),
    );

    const result = await importMemoriesFromDirectory(ingestor, tempDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.errors).toHaveLength(2);
    expect(result.value.errors[0]).toContain("bad.md");
    expect(result.value.errors[0]).toContain("Parse failed");
    expect(result.value.errors[1]).toContain("other.md");
    expect(result.value.errors[1]).toContain("Read error");
  });

  it("returns err(MemoryError) when directory does not exist", async () => {
    const ingestor = makeMockIngestor(async () => ok(makeScanReport()));
    const nonExistent = join(tempDir, "does-not-exist");

    const result = await importMemoriesFromDirectory(ingestor, nonExistent);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_IMPORT_FAILED");
    expect(result.error.message).toContain("not found");
  });

  it("returns err(MemoryError) when scanDirectory throws", async () => {
    const ingestor = makeMockIngestor(async () => {
      throw new Error("Unexpected scan failure");
    });

    const result = await importMemoriesFromDirectory(ingestor, tempDir);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_IMPORT_FAILED");
    expect(result.error.message).toContain("Failed to scan directory");
  });

  it("returns err(MemoryError) when scanDirectory returns err", async () => {
    const ingestor = makeMockIngestor(async () =>
      err(new MemoryIngestError("Disk read error")),
    );

    const result = await importMemoriesFromDirectory(ingestor, tempDir);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(MemoryError);
    expect(result.error.code).toBe("MEMORY_IMPORT_FAILED");
    expect(result.error.message).toContain("Disk read error");
  });

  it("returns ok with zero counts for an empty directory", async () => {
    const ingestor = makeMockIngestor(async () => ok(makeScanReport()));

    const result = await importMemoriesFromDirectory(ingestor, tempDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.imported).toBe(0);
    expect(result.value.skipped).toBe(0);
    expect(result.value.errors).toEqual([]);
  });
});
