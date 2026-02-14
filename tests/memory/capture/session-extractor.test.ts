import { describe, expect, it } from "bun:test";

import { err, ok, type Result } from "../../../src/result";
import type { Message } from "../../../src/types";
import type { ImplicitMemoryInput } from "../../../src/memory/services/memory-service";
import type { MemoryRecord } from "../../../src/memory/types/index";
import {
  SessionExtractor,
  SessionExtractionError,
  type SessionExtractorMemoryService,
} from "../../../src/memory/capture/session-extractor";

function message(id: string, content: string, role: "user" | "assistant" = "user"): Message {
  return {
    id,
    role,
    content,
    createdAt: new Date("2026-02-13T10:00:00.000Z"),
  };
}

function createPersistedRecord(id: string, input: ImplicitMemoryInput): MemoryRecord {
  const now = new Date("2026-02-13T10:00:00.000Z");
  return {
    id,
    content: input.content,
    type: input.type,
    layer: "stm",
    tags: input.tags ?? [],
    entities: input.entities ?? [],
    importance: 0.5,
    confidence: input.confidence,
    provenance: {
      sourceType: "implicit",
      conversationId: input.conversationId,
    },
    createdAt: now,
    updatedAt: now,
    accessedAt: now,
  };
}

class MockMemoryService implements SessionExtractorMemoryService {
  public readonly calls: ImplicitMemoryInput[] = [];
  private counter = 0;
  private readonly failOnCall: number | null;

  constructor(options?: { failOnCall?: number }) {
    this.failOnCall = options?.failOnCall ?? null;
  }

  async saveImplicit(input: ImplicitMemoryInput): Promise<Result<MemoryRecord>> {
    this.calls.push(input);
    this.counter += 1;

    if (this.failOnCall === this.counter) {
      return err(new Error("mock persistence failure"));
    }

    return ok(createPersistedRecord(`mem-${this.counter}`, input));
  }
}

describe("SessionExtractor", () => {
  it("extracts decisions, facts, preferences, and action items", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const messages: Message[] = [
      message("msg-1", "I'll go with Bun for this service."),
      message("msg-2", "My name is Jamie and I work at Reins."),
      message("msg-3", "I prefer TypeScript and I like strict mode."),
      message("msg-4", "TODO: remind me to run the migration tomorrow."),
    ];

    const result = await extractor.extractFromSession(messages, {
      sessionId: "session-1",
      conversationId: "conv-1",
      timestamp: new Date("2026-02-13T11:00:00.000Z"),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const categories = new Set(result.value.items.map((item) => item.category));
    expect(categories.has("decision")).toBe(true);
    expect(categories.has("fact")).toBe(true);
    expect(categories.has("preference")).toBe(true);
    expect(categories.has("action_item")).toBe(true);
    expect(result.value.conversationId).toBe("conv-1");
    expect(result.value.sessionId).toBe("session-1");
  });

  it("assigns confidence scores in 0-1 range", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });

    const result = await extractor.extractFromSession(
      [message("msg-1", "I prefer TypeScript.")],
      { sessionId: "session-1", conversationId: "conv-1" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items.length).toBeGreaterThan(0);
    for (const item of result.value.items) {
      expect(item.confidence).toBeGreaterThanOrEqual(0);
      expect(item.confidence).toBeLessThanOrEqual(1);
    }
  });

  it("filters extracted items by confidence threshold", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({
      memoryService,
      config: { confidenceThreshold: 0.9 },
    });

    const result = await extractor.extractFromSession(
      [
        message("msg-1", "It seems this might work."),
        message("msg-2", "I prefer direct answers."),
      ],
      { sessionId: "session-1", conversationId: "conv-1" },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.items.every((item) => item.confidence >= 0.9)).toBe(true);
    expect(result.value.items.some((item) => item.category === "observation")).toBe(false);
  });

  it("persists extractions with provenance metadata", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });

    const extraction = await extractor.extractFromSession(
      [
        message("msg-1", "I need to finish the API tests."),
        message("msg-2", "I prefer Bun test for this project."),
      ],
      {
        sessionId: "session-22",
        conversationId: "conv-22",
        timestamp: new Date("2026-02-13T12:00:00.000Z"),
      },
    );

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const persisted = await extractor.persistExtractions(extraction.value);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    expect(persisted.value.length).toBe(extraction.value.items.length);
    expect(memoryService.calls.length).toBe(extraction.value.items.length);

    for (const call of memoryService.calls) {
      expect(call.conversationId).toBe("conv-22");
      expect(call.tags?.some((tag) => tag === "session:session-22")).toBe(true);
      expect(call.tags?.some((tag) => tag.startsWith("extracted-at:"))).toBe(true);
      expect(call.tags?.some((tag) => tag.startsWith("extraction-version:"))).toBe(true);
      expect(call.entities?.some((entity) => entity.startsWith("message:"))).toBe(true);
    }
  });

  it("handles empty sessions", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });

    const extraction = await extractor.extractFromSession([], {
      sessionId: "session-empty",
      conversationId: "conv-empty",
    });
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    expect(extraction.value.items).toHaveLength(0);

    const persisted = await extractor.persistExtractions(extraction.value);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    expect(persisted.value).toEqual([]);
    expect(memoryService.calls).toHaveLength(0);
  });

  it("honors config overrides for max items and enabled categories", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({
      memoryService,
      config: {
        maxItemsPerSession: 1,
        enabledCategories: ["preference"],
      },
    });

    const extraction = await extractor.extractFromSession(
      [
        message("msg-1", "I prefer concise output."),
        message("msg-2", "I like strict checks."),
        message("msg-3", "I need to run tests."),
      ],
      { sessionId: "session-config", conversationId: "conv-config" },
    );

    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    expect(extraction.value.items).toHaveLength(1);
    expect(extraction.value.items[0].category).toBe("preference");
  });

  it("returns error for invalid session context", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });

    const extraction = await extractor.extractFromSession(
      [message("msg-1", "I prefer TypeScript")],
      { sessionId: "", conversationId: "conv-1" },
    );

    expect(extraction.ok).toBe(false);
    if (extraction.ok) return;
    expect(extraction.error).toBeInstanceOf(SessionExtractionError);
    expect(extraction.error.code).toBe("SESSION_EXTRACTOR_INVALID_CONTEXT");
  });

  it("returns error when persistence fails", async () => {
    const memoryService = new MockMemoryService({ failOnCall: 1 });
    const extractor = new SessionExtractor({ memoryService });

    const extraction = await extractor.extractFromSession(
      [message("msg-1", "I need to deploy this by Friday.")],
      { sessionId: "session-fail", conversationId: "conv-fail" },
    );
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const persisted = await extractor.persistExtractions(extraction.value);
    expect(persisted.ok).toBe(false);
    if (persisted.ok) return;

    expect(persisted.error).toBeInstanceOf(SessionExtractionError);
    expect(persisted.error.code).toBe("SESSION_EXTRACTOR_PERSIST_FAILED");
  });
});
