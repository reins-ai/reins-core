import { describe, expect, it } from "bun:test";

import { MemoryTool } from "../../src/tools/memory-tool";
import type { MemoryService } from "../../src/memory/services/memory-service";
import type { MemoryRecord } from "../../src/memory/types/memory-record";
import type { MemoryEvent } from "../../src/memory/types/memory-events";
import type { ToolContext } from "../../src/types";

const now = new Date("2026-02-20T12:00:00Z");

function makeMemoryRecord(overrides?: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: "mem-001",
    content: "User prefers dark mode",
    type: "preference",
    layer: "stm",
    tags: ["ui", "theme"],
    entities: [],
    importance: 0.7,
    confidence: 1.0,
    provenance: { sourceType: "explicit" },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
    ...overrides,
  };
}

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    conversationId: "conv-001",
    userId: "user-001",
    ...overrides,
  };
}

function createMockMemoryService(
  overrides?: Partial<Record<keyof MemoryService, unknown>>,
): MemoryService {
  return {
    isReady: () => true,
    initialize: async () => ({ ok: true as const, value: undefined }),
    shutdown: async () => ({ ok: true as const, value: undefined }),
    healthCheck: async () => ({ ok: true as const, value: { dbConnected: true, memoryCount: 0 } }),
    rememberExplicit: async () => ({ ok: true as const, value: makeMemoryRecord() }),
    saveImplicit: async () => ({ ok: true as const, value: makeMemoryRecord() }),
    saveBatch: async () => ({ ok: true as const, value: [] }),
    getById: async () => ({ ok: true as const, value: makeMemoryRecord() }),
    list: async () => ({ ok: true as const, value: [] }),
    update: async () => ({ ok: true as const, value: makeMemoryRecord() }),
    forget: async () => ({ ok: true as const, value: undefined }),
    count: async () => ({ ok: true as const, value: 0 }),
    ...overrides,
  } as unknown as MemoryService;
}

describe("MemoryTool", () => {
  describe("remember action", () => {
    it("creates a memory and returns record", async () => {
      const record = makeMemoryRecord({ content: "Likes TypeScript" });
      const service = createMockMemoryService({
        rememberExplicit: async () => ({ ok: true as const, value: record }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "remember", content: "Likes TypeScript" },
        makeContext(),
      );

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; memory: { content: string } };
      expect(data.action).toBe("remember");
      expect(data.memory.content).toBe("Likes TypeScript");
    });
  });

  describe("recall action", () => {
    it("filters memories by query", async () => {
      const records = [
        makeMemoryRecord({ id: "m1", content: "User prefers dark mode" }),
        makeMemoryRecord({ id: "m2", content: "User likes coffee" }),
        makeMemoryRecord({ id: "m3", content: "User works at Acme" }),
      ];
      const service = createMockMemoryService({
        list: async () => ({ ok: true as const, value: records }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "recall", query: "dark mode" },
        makeContext(),
      );

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; results: { id: string }[]; count: number };
      expect(data.action).toBe("recall");
      expect(data.count).toBe(1);
      expect(data.results[0].id).toBe("m1");
    });
  });

  describe("update action", () => {
    it("updates memory content by id", async () => {
      const updated = makeMemoryRecord({ content: "User prefers light mode" });
      const service = createMockMemoryService({
        update: async () => ({ ok: true as const, value: updated }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "update", id: "mem-001", content: "User prefers light mode" },
        makeContext(),
      );

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; memory: { content: string } };
      expect(data.action).toBe("update");
      expect(data.memory.content).toBe("User prefers light mode");
    });

    it("updates tags by id", async () => {
      const updated = makeMemoryRecord({ tags: ["design", "accessibility"] });
      const service = createMockMemoryService({
        update: async () => ({ ok: true as const, value: updated }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "update", id: "mem-001", tags: ["design", "accessibility"] },
        makeContext(),
      );

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; memory: { tags: string[] } };
      expect(data.action).toBe("update");
      expect(data.memory.tags).toEqual(["design", "accessibility"]);
    });

    it("updates importance by id", async () => {
      const updated = makeMemoryRecord({ importance: 0.9 });
      const service = createMockMemoryService({
        update: async () => ({ ok: true as const, value: updated }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "update", id: "mem-001", importance: 0.9 },
        makeContext(),
      );

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; memory: { importance: number } };
      expect(data.action).toBe("update");
      expect(data.memory.importance).toBe(0.9);
    });

    it("returns error when id not found", async () => {
      const service = createMockMemoryService({
        update: async () => ({
          ok: false as const,
          error: new Error("Memory not found"),
        }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "update", id: "nonexistent", content: "new content" },
        makeContext(),
      );

      expect(result.error).toBe("Memory not found");
    });

    it("returns error when no update fields provided", async () => {
      const service = createMockMemoryService();
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "update", id: "mem-001" },
        makeContext(),
      );

      expect(result.error).toContain("At least one of");
    });
  });

  describe("delete action", () => {
    it("removes memory by id", async () => {
      const service = createMockMemoryService({
        getById: async () => ({ ok: true as const, value: makeMemoryRecord() }),
        forget: async () => ({ ok: true as const, value: undefined }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "delete", id: "mem-001" },
        makeContext(),
      );

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; id: string };
      expect(data.action).toBe("delete");
      expect(data.id).toBe("mem-001");
    });

    it("returns error when id not found", async () => {
      const service = createMockMemoryService({
        getById: async () => ({ ok: true as const, value: null }),
        forget: async () => ({
          ok: false as const,
          error: new Error("Memory not found"),
        }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "delete", id: "nonexistent" },
        makeContext(),
      );

      expect(result.error).toBe("Memory not found");
    });
  });

  describe("list action", () => {
    it("returns all memories", async () => {
      const records = [
        makeMemoryRecord({ id: "m1", content: "Fact one" }),
        makeMemoryRecord({ id: "m2", content: "Fact two" }),
      ];
      const service = createMockMemoryService({
        list: async () => ({ ok: true as const, value: records }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "list" },
        makeContext(),
      );

      expect(result.error).toBeUndefined();
      const data = result.result as { action: string; memories: { id: string }[]; count: number };
      expect(data.action).toBe("list");
      expect(data.count).toBe(2);
      expect(data.memories).toHaveLength(2);
    });

    it("filters by type", async () => {
      let capturedOptions: Record<string, unknown> | undefined;
      const service = createMockMemoryService({
        list: async (options?: Record<string, unknown>) => {
          capturedOptions = options;
          return { ok: true as const, value: [] };
        },
      });
      const tool = new MemoryTool(service);

      await tool.execute(
        { action: "list", type: "preference" },
        makeContext(),
      );

      expect(capturedOptions).toBeDefined();
      expect(capturedOptions!.type).toBe("preference");
    });

    it("respects limit", async () => {
      let capturedOptions: Record<string, unknown> | undefined;
      const service = createMockMemoryService({
        list: async (options?: Record<string, unknown>) => {
          capturedOptions = options;
          return { ok: true as const, value: [] };
        },
      });
      const tool = new MemoryTool(service);

      await tool.execute(
        { action: "list", limit: 10 },
        makeContext(),
      );

      expect(capturedOptions).toBeDefined();
      expect(capturedOptions!.limit).toBe(10);
    });
  });

  describe("event emission", () => {
    it("emits created event after remember", async () => {
      const record = makeMemoryRecord();
      const service = createMockMemoryService({
        rememberExplicit: async () => ({ ok: true as const, value: record }),
      });

      const events: MemoryEvent[] = [];
      const tool = new MemoryTool(service, {
        onMemoryEvent: (event) => events.push(event),
      });

      await tool.execute(
        { action: "remember", content: "Test memory" },
        makeContext(),
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("created");
      expect(events[0].record.id).toBe(record.id);
      expect(events[0].timestamp).toBeInstanceOf(Date);
    });

    it("emits updated event after update", async () => {
      const updated = makeMemoryRecord({ content: "Updated content" });
      const service = createMockMemoryService({
        update: async () => ({ ok: true as const, value: updated }),
      });

      const events: MemoryEvent[] = [];
      const tool = new MemoryTool(service, {
        onMemoryEvent: (event) => events.push(event),
      });

      await tool.execute(
        { action: "update", id: "mem-001", content: "Updated content" },
        makeContext(),
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("updated");
      expect(events[0].record.content).toBe("Updated content");
    });

    it("emits deleted event after delete", async () => {
      const record = makeMemoryRecord();
      const service = createMockMemoryService({
        getById: async () => ({ ok: true as const, value: record }),
        forget: async () => ({ ok: true as const, value: undefined }),
      });

      const events: MemoryEvent[] = [];
      const tool = new MemoryTool(service, {
        onMemoryEvent: (event) => events.push(event),
      });

      await tool.execute(
        { action: "delete", id: "mem-001" },
        makeContext(),
      );

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("deleted");
      expect(events[0].record.id).toBe(record.id);
    });

    it("does not throw when no onMemoryEvent callback provided", async () => {
      const record = makeMemoryRecord();
      const service = createMockMemoryService({
        rememberExplicit: async () => ({ ok: true as const, value: record }),
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "remember", content: "Test memory" },
        makeContext(),
      );

      expect(result.error).toBeUndefined();
    });

    it("does not emit event when action fails", async () => {
      const service = createMockMemoryService({
        update: async () => ({
          ok: false as const,
          error: new Error("Not found"),
        }),
      });

      const events: MemoryEvent[] = [];
      const tool = new MemoryTool(service, {
        onMemoryEvent: (event) => events.push(event),
      });

      await tool.execute(
        { action: "update", id: "bad-id", content: "new" },
        makeContext(),
      );

      expect(events).toHaveLength(0);
    });
  });

  describe("error handling", () => {
    it("returns error for invalid action", async () => {
      const service = createMockMemoryService();
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "invalid" },
        makeContext(),
      );

      expect(result.error).toContain("Missing or invalid 'action'");
    });

    it("returns error when memory service is not ready", async () => {
      const service = createMockMemoryService({
        isReady: () => false,
      });
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "remember", content: "test" },
        makeContext(),
      );

      expect(result.error).toContain("Memory service is not ready");
    });

    it("returns error for invalid importance score", async () => {
      const service = createMockMemoryService();
      const tool = new MemoryTool(service);

      const result = await tool.execute(
        { action: "update", id: "mem-001", importance: 1.5 },
        makeContext(),
      );

      expect(result.error).toContain("importance");
    });
  });
});
