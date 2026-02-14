import { describe, expect, it } from "bun:test";

import {
  CompactionManager,
  type CompactionContext,
  MemoryPreservationHook,
  type PreCompactionHook,
} from "../../../src/conversation/compaction/index";
import { SessionExtractor, type SessionExtractorMemoryService } from "../../../src/memory/capture";
import { err, ok, type Result } from "../../../src/result";
import type { ImplicitMemoryInput } from "../../../src/memory/services/memory-service";
import type { MemoryRecord } from "../../../src/memory/types";
import type { Message } from "../../../src/types";

function createMessage(id: string, content: string, role: "user" | "assistant" = "user"): Message {
  return {
    id,
    role,
    content,
    createdAt: new Date("2026-02-13T10:00:00.000Z"),
  };
}

function createContext(overrides: Partial<CompactionContext> = {}): CompactionContext {
  return {
    conversationId: "conv-42",
    sessionId: "session-42",
    compactionReason: "token-threshold",
    timestamp: new Date("2026-02-13T12:00:00.000Z"),
    truncationPoint: 3,
    ...overrides,
  };
}

function createRecord(id: string, input: ImplicitMemoryInput): MemoryRecord {
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
  private readonly failOnCall: number | null;
  private callCount = 0;

  constructor(options?: { failOnCall?: number }) {
    this.failOnCall = options?.failOnCall ?? null;
  }

  async saveImplicit(input: ImplicitMemoryInput): Promise<Result<MemoryRecord>> {
    this.callCount += 1;
    this.calls.push(input);

    if (this.failOnCall === this.callCount) {
      return err(new Error("failed to persist"));
    }

    return ok(createRecord(`mem-${this.callCount}`, input));
  }
}

describe("MemoryPreservationHook", () => {
  it("extracts and persists high-value items before truncation", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const result = await hook.onPreCompaction(
      [
        createMessage("msg-1", "I prefer TypeScript for this repo."),
        createMessage("msg-2", "I've decided to use Bun for testing."),
        createMessage("msg-3", "My name is Alex."),
      ],
      createContext(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.extractedCount).toBeGreaterThan(0);
    expect(result.value.persistedCount).toBe(result.value.extractedCount);
    expect(memoryService.calls.length).toBe(result.value.persistedCount);
  });

  it("is idempotent for repeated compaction events", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });
    const messages = [
      createMessage("msg-1", "I prefer concise summaries."),
      createMessage("msg-2", "I will go with canary rollout first."),
    ];
    const context = createContext({ truncationPoint: 2 });

    const first = await hook.onPreCompaction(messages, context);
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }

    const savedAfterFirst = memoryService.calls.length;

    const second = await hook.onPreCompaction(messages, context);
    expect(second.ok).toBe(true);
    if (!second.ok) {
      return;
    }

    expect(second.value.persistedCount).toBe(0);
    expect(second.value.skippedDuplicates).toBe(1);
    expect(second.value.idempotencyKey).toBe(first.value.idempotencyKey);
    expect(memoryService.calls.length).toBe(savedAfterFirst);
  });

  it("tags preserved memories with compaction source metadata", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const result = await hook.onPreCompaction(
      [createMessage("msg-1", "I prefer tests before commits.")],
      createContext({ compactionReason: "manual-compact", truncationPoint: 1 }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(memoryService.calls.length).toBeGreaterThan(0);
    for (const call of memoryService.calls) {
      expect(call.tags?.includes("source:compaction")).toBe(true);
      expect(call.tags?.includes("compaction-reason:manual-compact")).toBe(true);
      expect(call.tags?.includes("compaction-truncation-point:1")).toBe(true);
    }
  });

  it("returns zero-count telemetry for empty message sets", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const result = await hook.onPreCompaction([], createContext({ truncationPoint: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.extractedCount).toBe(0);
    expect(result.value.persistedCount).toBe(0);
    expect(result.value.skippedDuplicates).toBe(0);
    expect(memoryService.calls).toHaveLength(0);
  });

  it("returns Result error when extraction context is invalid", async () => {
    const memoryService = new MockMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const result = await hook.onPreCompaction(
      [createMessage("msg-1", "I prefer strict TypeScript.")],
      createContext({ sessionId: "" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("COMPACTION_PRESERVATION_EXTRACT_FAILED");
  });

  it("returns Result error when persistence fails", async () => {
    const memoryService = new MockMemoryService({ failOnCall: 1 });
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const result = await hook.onPreCompaction(
      [createMessage("msg-1", "I prefer strict CI checks.")],
      createContext(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("COMPACTION_PRESERVATION_PERSIST_FAILED");
  });
});

describe("CompactionManager", () => {
  it("runs pre-compaction hooks before truncation", async () => {
    let hookExecuted = false;
    const manager = new CompactionManager({
      truncator: (messages, context) => {
        expect(hookExecuted).toBe(true);
        return ok({
          truncatedMessages: messages.slice(0, context.truncationPoint),
          retainedMessages: messages.slice(context.truncationPoint),
        });
      },
    });

    const hook: PreCompactionHook = {
      async onPreCompaction() {
        hookExecuted = true;
        return ok({
          extractedCount: 2,
          persistedCount: 2,
          idempotencyKey: "hook-a",
          skippedDuplicates: 0,
        });
      },
    };

    manager.addPreCompactionHook(hook);

    const result = await manager.compact(
      [
        createMessage("msg-1", "I prefer direct answers."),
        createMessage("msg-2", "I've decided to use Bun."),
        createMessage("msg-3", "Latest context"),
      ],
      createContext({ truncationPoint: 2 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.truncatedMessages).toHaveLength(2);
    expect(result.value.retainedMessages).toHaveLength(1);
    expect(result.value.telemetry.extractedCount).toBe(2);
    expect(result.value.telemetry.persistedCount).toBe(2);
  });

  it("supports multiple pre-compaction hooks", async () => {
    const manager = new CompactionManager();

    manager.addPreCompactionHook({
      async onPreCompaction() {
        return ok({
          extractedCount: 1,
          persistedCount: 1,
          idempotencyKey: "hook-1",
          skippedDuplicates: 0,
        });
      },
    });

    manager.addPreCompactionHook({
      async onPreCompaction() {
        return ok({
          extractedCount: 2,
          persistedCount: 1,
          idempotencyKey: "hook-2",
          skippedDuplicates: 1,
        });
      },
    });

    const result = await manager.compact(
      [
        createMessage("msg-1", "Old context"),
        createMessage("msg-2", "More old context"),
        createMessage("msg-3", "Latest context"),
      ],
      createContext({ truncationPoint: 2 }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.preservationResults).toHaveLength(2);
    expect(result.value.telemetry.extractedCount).toBe(3);
    expect(result.value.telemetry.persistedCount).toBe(2);
    expect(result.value.telemetry.skippedDuplicates).toBe(1);
  });
});
