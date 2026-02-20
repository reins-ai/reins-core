import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ok } from "../../../src/result";
import {
  MemorySummaryGenerator,
  formatRelativeDate,
} from "../../../src/memory/services/memory-summary-generator";
import type { MemoryRecord } from "../../../src/memory/types/memory-record";
import type { MemoryEvent } from "../../../src/memory/types/memory-events";
import type { MemoryRepository } from "../../../src/memory/storage/memory-repository";

function createRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  const now = new Date("2026-02-20T12:00:00.000Z");
  return {
    id: "test-id-1",
    content: "User prefers dark mode for all applications",
    type: "preference",
    layer: "ltm",
    tags: ["ui", "theme"],
    entities: [],
    importance: 0.8,
    confidence: 1.0,
    provenance: { sourceType: "explicit" },
    createdAt: new Date("2026-02-17T12:00:00.000Z"),
    updatedAt: now,
    accessedAt: new Date("2026-02-19T12:00:00.000Z"),
    ...overrides,
  };
}

function createMockRepository(records: MemoryRecord[]): MemoryRepository {
  return {
    list: async () => ok(records),
    findByType: async () => ok([]),
    findByLayer: async () => ok([]),
    create: async () => ok(records[0]!),
    getById: async () => ok(null),
    update: async () => ok(records[0]!),
    delete: async () => ok(undefined),
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

describe("MemorySummaryGenerator", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "memory-summary-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("generates correctly formatted Markdown with H2 sections per type", async () => {
    const records: MemoryRecord[] = [
      createRecord({
        id: "fact-1",
        type: "fact",
        content: "The capital of France is Paris",
        tags: ["geography"],
        importance: 0.9,
      }),
      createRecord({
        id: "pref-1",
        type: "preference",
        content: "User prefers dark mode",
        tags: ["ui"],
        importance: 0.7,
      }),
    ];

    const generator = new MemorySummaryGenerator({
      repository: createMockRepository(records),
    });

    const result = await generator.generate(tempDir);

    expect(result.ok).toBe(true);

    const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
    expect(content).toContain("# Memory Summary");
    expect(content).toContain("*Auto-generated. Last updated:");
    expect(content).toContain("## Facts");
    expect(content).toContain("### The capital of France is Paris");
    expect(content).toContain("- Importance: high");
    expect(content).toContain("- Tags: geography");
    expect(content).toContain("## Preferences");
    expect(content).toContain("### User prefers dark mode");
    expect(content).toContain("- Tags: ui");
  });

  it("only includes sections for types with records", async () => {
    const records: MemoryRecord[] = [
      createRecord({
        id: "decision-1",
        type: "decision",
        content: "Use PostgreSQL for the database",
        tags: ["architecture"],
        importance: 0.8,
      }),
    ];

    const generator = new MemorySummaryGenerator({
      repository: createMockRepository(records),
    });

    const result = await generator.generate(tempDir);

    expect(result.ok).toBe(true);

    const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
    expect(content).toContain("## Decisions");
    expect(content).not.toContain("## Facts");
    expect(content).not.toContain("## Preferences");
    expect(content).not.toContain("## Episodes");
    expect(content).not.toContain("## Skills");
    expect(content).not.toContain("## Entities");
    expect(content).not.toContain("## Document Chunks");
  });

  it("writes file to {envDir}/MEMORY.md", async () => {
    const generator = new MemorySummaryGenerator({
      repository: createMockRepository([
        createRecord({ id: "r1", type: "fact", content: "test content" }),
      ]),
    });

    const result = await generator.generate(tempDir);

    expect(result.ok).toBe(true);

    const filePath = join(tempDir, "MEMORY.md");
    const content = await readFile(filePath, "utf8");
    expect(content.length).toBeGreaterThan(0);
    expect(content).toContain("# Memory Summary");
  });

  it("returns ok(undefined) on success", async () => {
    const generator = new MemorySummaryGenerator({
      repository: createMockRepository([]),
    });

    const result = await generator.generate(tempDir);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  it("generates minimal MEMORY.md with header only when store is empty", async () => {
    const generator = new MemorySummaryGenerator({
      repository: createMockRepository([]),
    });

    const result = await generator.generate(tempDir);

    expect(result.ok).toBe(true);

    const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
    expect(content).toContain("# Memory Summary");
    expect(content).toContain("*Auto-generated. Last updated:");
    expect(content).not.toContain("## Facts");
    expect(content).not.toContain("## Preferences");
    expect(content).not.toContain("## Decisions");
    expect(content).not.toContain("## Episodes");
    expect(content).not.toContain("## Skills");
    expect(content).not.toContain("## Entities");
    expect(content).not.toContain("## Document Chunks");
  });

  it("debounces rapid successive calls so only the last writes", async () => {
    let listCallCount = 0;
    const repository = createMockRepository([
      createRecord({ id: "r1", type: "fact", content: "test" }),
    ]);
    const originalList = repository.list.bind(repository);
    repository.list = async () => {
      listCallCount += 1;
      return originalList();
    };

    const generator = new MemorySummaryGenerator({
      repository,
      debounceMs: 50,
    });

    const callback = generator.subscribeToEvents(tempDir);
    const event: MemoryEvent = {
      type: "created",
      record: createRecord(),
      timestamp: new Date(),
    };

    callback(event);
    callback(event);
    callback(event);

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(listCallCount).toBe(1);

    const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
    expect(content).toContain("# Memory Summary");

    generator.cancelPending();
  });

  it("subscribeToEvents triggers generate on MemoryEvent", async () => {
    const records = [createRecord({ id: "r1", type: "skill", content: "TypeScript patterns" })];
    const generator = new MemorySummaryGenerator({
      repository: createMockRepository(records),
      debounceMs: 10,
    });

    const callback = generator.subscribeToEvents(tempDir);
    const event: MemoryEvent = {
      type: "created",
      record: createRecord(),
      timestamp: new Date(),
    };

    callback(event);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
    expect(content).toContain("## Skills");
    expect(content).toContain("### TypeScript patterns");

    generator.cancelPending();
  });

  it("truncates long content previews to 80 characters", async () => {
    const longContent =
      "This is a very long memory content that exceeds eighty characters and should be truncated with an ellipsis at the end";
    const records = [createRecord({ id: "r1", type: "fact", content: longContent })];

    const generator = new MemorySummaryGenerator({
      repository: createMockRepository(records),
    });

    const result = await generator.generate(tempDir);

    expect(result.ok).toBe(true);

    const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
    const lines = content.split("\n");
    const headingLine = lines.find((line) => line.startsWith("### "));
    expect(headingLine).toBeDefined();
    const headingText = headingLine!.slice(4);
    expect(headingText.length).toBeLessThanOrEqual(80);
    expect(headingText).toEndWith("...");
  });

  it("displays importance levels correctly", async () => {
    const records: MemoryRecord[] = [
      createRecord({ id: "high", type: "fact", content: "High importance", importance: 0.9 }),
      createRecord({ id: "med", type: "preference", content: "Medium importance", importance: 0.5 }),
      createRecord({ id: "low", type: "decision", content: "Low importance", importance: 0.2 }),
    ];

    const generator = new MemorySummaryGenerator({
      repository: createMockRepository(records),
    });

    const result = await generator.generate(tempDir);

    expect(result.ok).toBe(true);

    const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
    const sections = content.split("###");
    const highSection = sections.find((s) => s.includes("High importance"));
    const medSection = sections.find((s) => s.includes("Medium importance"));
    const lowSection = sections.find((s) => s.includes("Low importance"));

    expect(highSection).toContain("Importance: high");
    expect(medSection).toContain("Importance: medium");
    expect(lowSection).toContain("Importance: low");
  });

  it("shows tags as 'none' when record has no tags", async () => {
    const records = [createRecord({ id: "r1", type: "fact", content: "No tags", tags: [] })];

    const generator = new MemorySummaryGenerator({
      repository: createMockRepository(records),
    });

    const result = await generator.generate(tempDir);

    expect(result.ok).toBe(true);

    const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
    expect(content).toContain("- Tags: none");
  });

  it("groups records by type in the canonical MEMORY_TYPES order", async () => {
    const records: MemoryRecord[] = [
      createRecord({ id: "entity-1", type: "entity", content: "Entity record" }),
      createRecord({ id: "fact-1", type: "fact", content: "Fact record" }),
      createRecord({ id: "skill-1", type: "skill", content: "Skill record" }),
    ];

    const generator = new MemorySummaryGenerator({
      repository: createMockRepository(records),
    });

    const result = await generator.generate(tempDir);

    expect(result.ok).toBe(true);

    const content = await readFile(join(tempDir, "MEMORY.md"), "utf8");
    const factIndex = content.indexOf("## Facts");
    const skillIndex = content.indexOf("## Skills");
    const entityIndex = content.indexOf("## Entities");

    expect(factIndex).toBeLessThan(skillIndex);
    expect(skillIndex).toBeLessThan(entityIndex);
  });

  it("cancelPending clears any scheduled debounce", async () => {
    let listCallCount = 0;
    const repository = createMockRepository([]);
    repository.list = async () => {
      listCallCount += 1;
      return ok([]);
    };

    const generator = new MemorySummaryGenerator({
      repository,
      debounceMs: 50,
    });

    const callback = generator.subscribeToEvents(tempDir);
    callback({ type: "created", record: createRecord(), timestamp: new Date() });

    generator.cancelPending();

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(listCallCount).toBe(0);
  });
});

describe("formatRelativeDate", () => {
  const now = new Date("2026-02-20T12:00:00.000Z");

  it("returns 'just now' for dates less than a minute ago", () => {
    const date = new Date("2026-02-20T11:59:30.000Z");
    expect(formatRelativeDate(date, now)).toBe("just now");
  });

  it("returns '1 minute ago' for exactly one minute", () => {
    const date = new Date("2026-02-20T11:59:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("1 minute ago");
  });

  it("returns '5 minutes ago' for five minutes", () => {
    const date = new Date("2026-02-20T11:55:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("5 minutes ago");
  });

  it("returns '1 hour ago' for exactly one hour", () => {
    const date = new Date("2026-02-20T11:00:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("1 hour ago");
  });

  it("returns '3 hours ago' for three hours", () => {
    const date = new Date("2026-02-20T09:00:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("3 hours ago");
  });

  it("returns '1 day ago' for exactly one day", () => {
    const date = new Date("2026-02-19T12:00:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("1 day ago");
  });

  it("returns '3 days ago' for three days", () => {
    const date = new Date("2026-02-17T12:00:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("3 days ago");
  });

  it("returns '1 month ago' for thirty days", () => {
    const date = new Date("2026-01-21T12:00:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("1 month ago");
  });

  it("returns '2 months ago' for sixty days", () => {
    const date = new Date("2025-12-22T12:00:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("2 months ago");
  });

  it("returns '1 year ago' for twelve months", () => {
    const date = new Date("2025-02-20T12:00:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("1 year ago");
  });

  it("returns '2 years ago' for twenty-four months", () => {
    const date = new Date("2024-02-20T12:00:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("2 years ago");
  });

  it("returns 'just now' for future dates", () => {
    const date = new Date("2026-02-21T12:00:00.000Z");
    expect(formatRelativeDate(date, now)).toBe("just now");
  });
});
