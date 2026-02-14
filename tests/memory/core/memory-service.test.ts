import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SqliteMemoryDb,
  SqliteMemoryRepository,
} from "../../../src/memory/storage";
import {
  MemoryService,
  type ExplicitMemoryInput,
  type ImplicitMemoryInput,
  type MemoryLogger,
} from "../../../src/memory/services/memory-service";
import {
  ContentPolicy,
  ConfidencePolicy,
  AttributionPolicy,
  DuplicatePolicy,
  runPolicies,
  MAX_CONTENT_LENGTH,
  MIN_IMPLICIT_CONFIDENCE,
  type DuplicateChecker,
} from "../../../src/memory/services/memory-write-policies";
import type { CreateMemoryInput } from "../../../src/memory/storage/memory-repository";

interface TestContext {
  rootDir: string;
  dataDir: string;
  memoryDb: SqliteMemoryDb;
  repository: SqliteMemoryRepository;
  service: MemoryService;
  logs: { level: string; message: string }[];
}

const contexts: TestContext[] = [];

function createTestLogger(logs: { level: string; message: string }[]): MemoryLogger {
  return {
    info(message: string) {
      logs.push({ level: "info", message });
    },
    warn(message: string) {
      logs.push({ level: "warn", message });
    },
    error(message: string) {
      logs.push({ level: "error", message });
    },
  };
}

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

  const logs: { level: string; message: string }[] = [];
  const service = new MemoryService({
    repository,
    logger: createTestLogger(logs),
  });

  const context: TestContext = {
    rootDir,
    dataDir,
    memoryDb,
    repository,
    service,
    logs,
  };

  contexts.push(context);
  return context;
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

describe("MemoryService", () => {
  describe("lifecycle", () => {
    test("initializes and reports ready", async () => {
      const ctx = await createTestContext("svc-init-");
      expect(ctx.service.isReady()).toBe(false);

      const result = await ctx.service.initialize();
      expect(result.ok).toBe(true);
      expect(ctx.service.isReady()).toBe(true);
    });

    test("shuts down and reports not ready", async () => {
      const ctx = await createTestContext("svc-shutdown-");
      await ctx.service.initialize();
      expect(ctx.service.isReady()).toBe(true);

      const result = await ctx.service.shutdown();
      expect(result.ok).toBe(true);
      expect(ctx.service.isReady()).toBe(false);
    });

    test("rejects operations when not initialized", async () => {
      const ctx = await createTestContext("svc-notready-");

      const result = await ctx.service.rememberExplicit({ content: "test" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("MEMORY_NOT_READY");
      }
    });

    test("rejects operations after shutdown", async () => {
      const ctx = await createTestContext("svc-aftershutdown-");
      await ctx.service.initialize();
      await ctx.service.shutdown();

      const result = await ctx.service.getById("some-id");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("MEMORY_NOT_READY");
      }
    });
  });

  describe("healthCheck", () => {
    test("returns health status with memory count", async () => {
      const ctx = await createTestContext("svc-health-");
      await ctx.service.initialize();

      const health = await ctx.service.healthCheck();
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.dbConnected).toBe(true);
        expect(health.value.memoryCount).toBe(0);
      }
    });

    test("reflects memory count after writes", async () => {
      const ctx = await createTestContext("svc-health-count-");
      await ctx.service.initialize();

      await ctx.service.rememberExplicit({ content: "First memory" });
      await ctx.service.rememberExplicit({ content: "Second memory" });

      const health = await ctx.service.healthCheck();
      expect(health.ok).toBe(true);
      if (health.ok) {
        expect(health.value.memoryCount).toBe(2);
      }
    });

    test("fails when not initialized", async () => {
      const ctx = await createTestContext("svc-health-notready-");

      const health = await ctx.service.healthCheck();
      expect(health.ok).toBe(false);
      if (!health.ok) {
        expect(health.error.code).toBe("MEMORY_NOT_READY");
      }
    });
  });

  describe("rememberExplicit", () => {
    test("creates memory with explicit source attribution", async () => {
      const ctx = await createTestContext("svc-explicit-");
      await ctx.service.initialize();

      const input: ExplicitMemoryInput = {
        content: "User prefers dark mode",
        type: "preference",
        tags: ["ui", "theme"],
        entities: ["user"],
        conversationId: "conv-123",
        messageId: "msg-456",
      };

      const result = await ctx.service.rememberExplicit(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe("User prefers dark mode");
        expect(result.value.type).toBe("preference");
        expect(result.value.provenance.sourceType).toBe("explicit");
        expect(result.value.provenance.conversationId).toBe("conv-123");
        expect(result.value.importance).toBe(0.7);
        expect(result.value.confidence).toBe(1.0);
        expect(result.value.layer).toBe("stm");
        expect(result.value.tags).toEqual(["ui", "theme"]);
        expect(result.value.entities).toEqual(["user"]);
      }
    });

    test("defaults type to fact when not specified", async () => {
      const ctx = await createTestContext("svc-explicit-default-");
      await ctx.service.initialize();

      const result = await ctx.service.rememberExplicit({
        content: "The meeting is at 3pm",
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.type).toBe("fact");
      }
    });

    test("persists and is retrievable by id", async () => {
      const ctx = await createTestContext("svc-explicit-retrieve-");
      await ctx.service.initialize();

      const created = await ctx.service.rememberExplicit({
        content: "Important fact to remember",
        conversationId: "conv-abc",
      });

      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const retrieved = await ctx.service.getById(created.value.id);
      expect(retrieved.ok).toBe(true);
      if (retrieved.ok) {
        expect(retrieved.value).not.toBeNull();
        expect(retrieved.value!.content).toBe("Important fact to remember");
        expect(retrieved.value!.provenance.sourceType).toBe("explicit");
        expect(retrieved.value!.provenance.conversationId).toBe("conv-abc");
      }
    });

    test("rejects empty content", async () => {
      const ctx = await createTestContext("svc-explicit-empty-");
      await ctx.service.initialize();

      const result = await ctx.service.rememberExplicit({ content: "" });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("content");
      }
    });

    test("rejects content exceeding max length", async () => {
      const ctx = await createTestContext("svc-explicit-long-");
      await ctx.service.initialize();

      const longContent = "x".repeat(MAX_CONTENT_LENGTH + 1);
      const result = await ctx.service.rememberExplicit({ content: longContent });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("maximum length");
      }
    });
  });

  describe("saveImplicit", () => {
    test("creates memory with implicit source attribution", async () => {
      const ctx = await createTestContext("svc-implicit-");
      await ctx.service.initialize();

      const input: ImplicitMemoryInput = {
        content: "User seems to prefer TypeScript over JavaScript",
        type: "preference",
        confidence: 0.8,
        tags: ["language", "coding"],
        entities: ["user"],
        conversationId: "conv-789",
        messageId: "msg-012",
      };

      const result = await ctx.service.saveImplicit(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.content).toBe("User seems to prefer TypeScript over JavaScript");
        expect(result.value.type).toBe("preference");
        expect(result.value.provenance.sourceType).toBe("implicit");
        expect(result.value.provenance.conversationId).toBe("conv-789");
        expect(result.value.importance).toBe(0.5);
        expect(result.value.confidence).toBe(0.8);
        expect(result.value.layer).toBe("stm");
      }
    });

    test("rejects implicit memory without conversationId", async () => {
      const ctx = await createTestContext("svc-implicit-noconv-");
      await ctx.service.initialize();

      const input: ImplicitMemoryInput = {
        content: "Some extracted fact",
        type: "fact",
        confidence: 0.7,
        conversationId: "",
      };

      const result = await ctx.service.saveImplicit(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("conversationId");
      }
    });

    test("rejects implicit memory with low confidence", async () => {
      const ctx = await createTestContext("svc-implicit-lowconf-");
      await ctx.service.initialize();

      const input: ImplicitMemoryInput = {
        content: "Maybe user likes cats?",
        type: "preference",
        confidence: 0.1,
        conversationId: "conv-low",
      };

      const result = await ctx.service.saveImplicit(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("confidence");
        expect(result.error.message).toContain(String(MIN_IMPLICIT_CONFIDENCE));
      }
    });

    test("accepts implicit memory at exact confidence threshold", async () => {
      const ctx = await createTestContext("svc-implicit-threshold-");
      await ctx.service.initialize();

      const input: ImplicitMemoryInput = {
        content: "User mentioned liking coffee",
        type: "preference",
        confidence: MIN_IMPLICIT_CONFIDENCE,
        conversationId: "conv-threshold",
      };

      const result = await ctx.service.saveImplicit(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.confidence).toBe(MIN_IMPLICIT_CONFIDENCE);
      }
    });

    test("rejects empty content for implicit memories", async () => {
      const ctx = await createTestContext("svc-implicit-empty-");
      await ctx.service.initialize();

      const input: ImplicitMemoryInput = {
        content: "   ",
        type: "fact",
        confidence: 0.8,
        conversationId: "conv-empty",
      };

      const result = await ctx.service.saveImplicit(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.message).toContain("content");
      }
    });
  });

  describe("saveBatch", () => {
    test("creates multiple implicit memories", async () => {
      const ctx = await createTestContext("svc-batch-");
      await ctx.service.initialize();

      const inputs: ImplicitMemoryInput[] = [
        {
          content: "User decided to use Bun runtime",
          type: "decision",
          confidence: 0.9,
          conversationId: "conv-batch",
          tags: ["runtime"],
        },
        {
          content: "User prefers functional programming",
          type: "preference",
          confidence: 0.7,
          conversationId: "conv-batch",
          tags: ["coding-style"],
        },
        {
          content: "Meeting scheduled for Friday",
          type: "fact",
          confidence: 0.95,
          conversationId: "conv-batch",
        },
      ];

      const result = await ctx.service.saveBatch(inputs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
        expect(result.value[0].type).toBe("decision");
        expect(result.value[1].type).toBe("preference");
        expect(result.value[2].type).toBe("fact");

        for (const record of result.value) {
          expect(record.provenance.sourceType).toBe("implicit");
          expect(record.provenance.conversationId).toBe("conv-batch");
        }
      }
    });

    test("skips invalid entries and continues batch", async () => {
      const ctx = await createTestContext("svc-batch-partial-");
      await ctx.service.initialize();

      const inputs: ImplicitMemoryInput[] = [
        {
          content: "Valid memory",
          type: "fact",
          confidence: 0.8,
          conversationId: "conv-batch-partial",
        },
        {
          content: "Low confidence memory",
          type: "fact",
          confidence: 0.1,
          conversationId: "conv-batch-partial",
        },
        {
          content: "Another valid memory",
          type: "fact",
          confidence: 0.9,
          conversationId: "conv-batch-partial",
        },
      ];

      const result = await ctx.service.saveBatch(inputs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
        expect(result.value[0].content).toBe("Valid memory");
        expect(result.value[1].content).toBe("Another valid memory");
      }
    });

    test("returns empty array for all-invalid batch", async () => {
      const ctx = await createTestContext("svc-batch-allinvalid-");
      await ctx.service.initialize();

      const inputs: ImplicitMemoryInput[] = [
        {
          content: "",
          type: "fact",
          confidence: 0.8,
          conversationId: "conv-invalid",
        },
        {
          content: "Low conf",
          type: "fact",
          confidence: 0.05,
          conversationId: "conv-invalid",
        },
      ];

      const result = await ctx.service.saveBatch(inputs);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });

    test("handles empty batch input", async () => {
      const ctx = await createTestContext("svc-batch-empty-");
      await ctx.service.initialize();

      const result = await ctx.service.saveBatch([]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });
  });

  describe("list", () => {
    test("lists memories with default pagination", async () => {
      const ctx = await createTestContext("svc-list-");
      await ctx.service.initialize();

      await ctx.service.rememberExplicit({ content: "Memory one" });
      await ctx.service.rememberExplicit({ content: "Memory two" });
      await ctx.service.rememberExplicit({ content: "Memory three" });

      const result = await ctx.service.list();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(3);
      }
    });

    test("filters by memory type", async () => {
      const ctx = await createTestContext("svc-list-type-");
      await ctx.service.initialize();

      await ctx.service.rememberExplicit({ content: "A fact", type: "fact" });
      await ctx.service.rememberExplicit({ content: "A preference", type: "preference" });
      await ctx.service.rememberExplicit({ content: "Another fact", type: "fact" });

      const result = await ctx.service.list({ type: "fact" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(2);
        for (const record of result.value) {
          expect(record.type).toBe("fact");
        }
      }
    });

    test("filters by memory layer", async () => {
      const ctx = await createTestContext("svc-list-layer-");
      await ctx.service.initialize();

      await ctx.service.rememberExplicit({ content: "STM memory" });

      const stmResult = await ctx.service.list({ layer: "stm" });
      expect(stmResult.ok).toBe(true);
      if (stmResult.ok) {
        expect(stmResult.value.length).toBe(1);
      }

      const ltmResult = await ctx.service.list({ layer: "ltm" });
      expect(ltmResult.ok).toBe(true);
      if (ltmResult.ok) {
        expect(ltmResult.value.length).toBe(0);
      }
    });

    test("respects limit and offset", async () => {
      const ctx = await createTestContext("svc-list-pagination-");
      await ctx.service.initialize();

      for (let i = 0; i < 5; i++) {
        await ctx.service.rememberExplicit({ content: `Memory ${i}` });
      }

      const page1 = await ctx.service.list({ limit: 2, offset: 0 });
      expect(page1.ok).toBe(true);
      if (page1.ok) {
        expect(page1.value.length).toBe(2);
      }

      const page2 = await ctx.service.list({ limit: 2, offset: 2 });
      expect(page2.ok).toBe(true);
      if (page2.ok) {
        expect(page2.value.length).toBe(2);
      }

      const page3 = await ctx.service.list({ limit: 2, offset: 4 });
      expect(page3.ok).toBe(true);
      if (page3.ok) {
        expect(page3.value.length).toBe(1);
      }
    });

    test("returns empty array when no memories exist", async () => {
      const ctx = await createTestContext("svc-list-empty-");
      await ctx.service.initialize();

      const result = await ctx.service.list();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.length).toBe(0);
      }
    });
  });

  describe("update", () => {
    test("updates memory content", async () => {
      const ctx = await createTestContext("svc-update-");
      await ctx.service.initialize();

      const created = await ctx.service.rememberExplicit({
        content: "Original content",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const updated = await ctx.service.update(created.value.id, {
        content: "Updated content",
      });

      expect(updated.ok).toBe(true);
      if (updated.ok) {
        expect(updated.value.content).toBe("Updated content");
        expect(updated.value.id).toBe(created.value.id);
      }
    });

    test("updates importance and tags", async () => {
      const ctx = await createTestContext("svc-update-fields-");
      await ctx.service.initialize();

      const created = await ctx.service.rememberExplicit({
        content: "Some memory",
        tags: ["old-tag"],
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const updated = await ctx.service.update(created.value.id, {
        importance: 0.9,
        tags: ["new-tag", "important"],
      });

      expect(updated.ok).toBe(true);
      if (updated.ok) {
        expect(updated.value.importance).toBe(0.9);
        expect(updated.value.tags).toEqual(["new-tag", "important"]);
      }
    });

    test("returns error for non-existent memory", async () => {
      const ctx = await createTestContext("svc-update-notfound-");
      await ctx.service.initialize();

      const result = await ctx.service.update("non-existent-id", {
        content: "Updated",
      });

      expect(result.ok).toBe(false);
    });
  });

  describe("forget", () => {
    test("deletes a memory by id", async () => {
      const ctx = await createTestContext("svc-forget-");
      await ctx.service.initialize();

      const created = await ctx.service.rememberExplicit({
        content: "Memory to forget",
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const deleteResult = await ctx.service.forget(created.value.id);
      expect(deleteResult.ok).toBe(true);

      const retrieved = await ctx.service.getById(created.value.id);
      expect(retrieved.ok).toBe(true);
      if (retrieved.ok) {
        expect(retrieved.value).toBeNull();
      }
    });

    test("succeeds silently for non-existent id", async () => {
      const ctx = await createTestContext("svc-forget-missing-");
      await ctx.service.initialize();

      const result = await ctx.service.forget("non-existent-id");
      expect(result.ok).toBe(true);
    });

    test("reduces memory count after deletion", async () => {
      const ctx = await createTestContext("svc-forget-count-");
      await ctx.service.initialize();

      await ctx.service.rememberExplicit({ content: "Keep this" });
      const toDelete = await ctx.service.rememberExplicit({ content: "Delete this" });
      expect(toDelete.ok).toBe(true);
      if (!toDelete.ok) return;

      const beforeCount = await ctx.service.count();
      expect(beforeCount.ok).toBe(true);
      if (beforeCount.ok) {
        expect(beforeCount.value).toBe(2);
      }

      await ctx.service.forget(toDelete.value.id);

      const afterCount = await ctx.service.count();
      expect(afterCount.ok).toBe(true);
      if (afterCount.ok) {
        expect(afterCount.value).toBe(1);
      }
    });
  });

  describe("count", () => {
    test("returns total count without filter", async () => {
      const ctx = await createTestContext("svc-count-");
      await ctx.service.initialize();

      await ctx.service.rememberExplicit({ content: "One" });
      await ctx.service.rememberExplicit({ content: "Two" });

      const result = await ctx.service.count();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(2);
      }
    });

    test("returns filtered count by type", async () => {
      const ctx = await createTestContext("svc-count-type-");
      await ctx.service.initialize();

      await ctx.service.rememberExplicit({ content: "A fact", type: "fact" });
      await ctx.service.rememberExplicit({ content: "A pref", type: "preference" });
      await ctx.service.rememberExplicit({ content: "Another fact", type: "fact" });

      const result = await ctx.service.count({ type: "preference" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
    });

    test("returns zero for empty store", async () => {
      const ctx = await createTestContext("svc-count-empty-");
      await ctx.service.initialize();

      const result = await ctx.service.count();
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(0);
      }
    });
  });

  describe("duplicate detection", () => {
    test("logs warning for duplicate content but still creates", async () => {
      const ctx = await createTestContext("svc-dup-");
      await ctx.service.initialize();

      const first = await ctx.service.rememberExplicit({
        content: "Duplicate content here",
      });
      expect(first.ok).toBe(true);

      const second = await ctx.service.rememberExplicit({
        content: "Duplicate content here",
      });
      expect(second.ok).toBe(true);

      const warnings = ctx.logs.filter(
        (log) => log.level === "warn" && log.message.includes("duplicate"),
      );
      expect(warnings.length).toBe(1);

      const count = await ctx.service.count();
      expect(count.ok).toBe(true);
      if (count.ok) {
        expect(count.value).toBe(2);
      }
    });
  });
});

describe("WritePolicies", () => {
  function makeInput(overrides?: Partial<CreateMemoryInput>): CreateMemoryInput {
    return {
      content: "Test content",
      type: "fact",
      layer: "stm",
      importance: 0.5,
      confidence: 0.8,
      source: {
        type: "explicit",
        conversationId: "conv-test",
      },
      ...overrides,
    };
  }

  describe("ContentPolicy", () => {
    const policy = new ContentPolicy();

    test("passes for valid content", () => {
      const result = policy.validate(makeInput());
      expect(result.ok).toBe(true);
    });

    test("rejects empty content", () => {
      const result = policy.validate(makeInput({ content: "" }));
      expect(result.ok).toBe(false);
    });

    test("rejects whitespace-only content", () => {
      const result = policy.validate(makeInput({ content: "   " }));
      expect(result.ok).toBe(false);
    });

    test("rejects content exceeding max length", () => {
      const result = policy.validate(
        makeInput({ content: "x".repeat(MAX_CONTENT_LENGTH + 1) }),
      );
      expect(result.ok).toBe(false);
    });

    test("accepts content at exact max length", () => {
      const result = policy.validate(
        makeInput({ content: "x".repeat(MAX_CONTENT_LENGTH) }),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("ConfidencePolicy", () => {
    const policy = new ConfidencePolicy();

    test("passes for explicit memories regardless of confidence", () => {
      const result = policy.validate(
        makeInput({ confidence: 0.01, source: { type: "explicit" } }),
      );
      expect(result.ok).toBe(true);
    });

    test("passes for implicit memories with sufficient confidence", () => {
      const result = policy.validate(
        makeInput({
          confidence: 0.5,
          source: { type: "implicit", conversationId: "conv" },
        }),
      );
      expect(result.ok).toBe(true);
    });

    test("rejects implicit memories with low confidence", () => {
      const result = policy.validate(
        makeInput({
          confidence: 0.1,
          source: { type: "implicit", conversationId: "conv" },
        }),
      );
      expect(result.ok).toBe(false);
    });

    test("passes at exact threshold", () => {
      const result = policy.validate(
        makeInput({
          confidence: MIN_IMPLICIT_CONFIDENCE,
          source: { type: "implicit", conversationId: "conv" },
        }),
      );
      expect(result.ok).toBe(true);
    });
  });

  describe("AttributionPolicy", () => {
    const policy = new AttributionPolicy();

    test("passes for explicit memories without conversationId", () => {
      const result = policy.validate(
        makeInput({ source: { type: "explicit" } }),
      );
      expect(result.ok).toBe(true);
    });

    test("passes for implicit memories with conversationId", () => {
      const result = policy.validate(
        makeInput({
          source: { type: "implicit", conversationId: "conv-123" },
        }),
      );
      expect(result.ok).toBe(true);
    });

    test("rejects implicit memories without conversationId", () => {
      const result = policy.validate(
        makeInput({ source: { type: "implicit" } }),
      );
      expect(result.ok).toBe(false);
    });

    test("rejects implicit memories with empty conversationId", () => {
      const result = policy.validate(
        makeInput({
          source: { type: "implicit", conversationId: "" },
        }),
      );
      expect(result.ok).toBe(false);
    });
  });

  describe("DuplicatePolicy", () => {
    test("synchronous validate always passes", () => {
      const checker: DuplicateChecker = {
        async hasExactContent() {
          return true;
        },
      };

      const policy = new DuplicatePolicy(checker);
      const result = policy.validate(makeInput());
      expect(result.ok).toBe(true);
    });

    test("async check returns warning for duplicate", async () => {
      const checker: DuplicateChecker = {
        async hasExactContent() {
          return true;
        },
      };

      const policy = new DuplicatePolicy(checker);
      const warning = await policy.checkDuplicateAsync("some content");
      expect(warning).not.toBeNull();
      expect(warning!.policy).toBe("duplicate");
    });

    test("async check returns null for unique content", async () => {
      const checker: DuplicateChecker = {
        async hasExactContent() {
          return false;
        },
      };

      const policy = new DuplicatePolicy(checker);
      const warning = await policy.checkDuplicateAsync("unique content");
      expect(warning).toBeNull();
    });
  });

  describe("runPolicies", () => {
    test("returns passed when all policies pass", () => {
      const policies = [new ContentPolicy(), new ConfidencePolicy(), new AttributionPolicy()];
      const result = runPolicies(policies, makeInput());
      expect(result.passed).toBe(true);
      expect(result.violations.length).toBe(0);
    });

    test("collects all violations from multiple failing policies", () => {
      const policies = [new ContentPolicy(), new ConfidencePolicy(), new AttributionPolicy()];
      const input = makeInput({
        content: "",
        confidence: 0.1,
        source: { type: "implicit" },
      });

      const result = runPolicies(policies, input);
      expect(result.passed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(2);
    });
  });
});
