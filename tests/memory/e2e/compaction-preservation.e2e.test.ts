import { describe, expect, it } from "bun:test";

import { ok, err, type Result } from "../../../src/result";
import type { Message } from "../../../src/types";
import type { ImplicitMemoryInput } from "../../../src/memory/services/memory-service";
import type { MemoryRecord } from "../../../src/memory/types/index";
import {
  SessionExtractor,
  type SessionExtractorMemoryService,
} from "../../../src/memory/capture/session-extractor";
import {
  MemoryPreservationHook,
  type CompactionContext,
} from "../../../src/conversation/compaction/memory-preservation-hook";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_DATE = new Date("2026-02-13T10:00:00.000Z");

function msg(
  id: string,
  content: string,
  role: "user" | "assistant" = "user",
  offsetMinutes = 0,
): Message {
  return {
    id,
    role,
    content,
    createdAt: new Date(BASE_DATE.getTime() + offsetMinutes * 60_000),
  };
}

function createRecord(id: string, input: ImplicitMemoryInput): MemoryRecord {
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
    createdAt: BASE_DATE,
    updatedAt: BASE_DATE,
    accessedAt: BASE_DATE,
  };
}

function compactionContext(overrides: Partial<CompactionContext> = {}): CompactionContext {
  return {
    conversationId: "e2e-conv-compact",
    sessionId: "e2e-session-compact",
    compactionReason: "token-limit-exceeded",
    timestamp: new Date("2026-02-13T12:00:00.000Z"),
    truncationPoint: 5,
    ...overrides,
  };
}

/**
 * In-memory mock that tracks every saveImplicit call for assertion.
 */
class TrackingMemoryService implements SessionExtractorMemoryService {
  public readonly saved: Array<{ id: string; input: ImplicitMemoryInput }> = [];
  private counter = 0;

  async saveImplicit(input: ImplicitMemoryInput): Promise<Result<MemoryRecord>> {
    this.counter += 1;
    const id = `mem-${this.counter}`;
    const record = createRecord(id, input);
    this.saved.push({ id, input });
    return ok(record);
  }
}

// ---------------------------------------------------------------------------
// Conversation fixtures for compaction scenarios
// ---------------------------------------------------------------------------

/**
 * Creates a conversation with a mix of high-value (decision, fact, preference)
 * and low-value (observation, action_item) content, plus non-extractable filler.
 * The truncation point splits the conversation so earlier messages are "about to
 * be compacted away."
 */
function createCompactionConversation(): Message[] {
  return [
    // Pre-truncation messages (these would be lost without preservation)
    msg("c-01", "I'll go with PostgreSQL for the database.", "user", 0),
    msg("c-02", "Good choice for relational data.", "assistant", 1),
    msg("c-03", "My name is Casey and I work at DataFlow Inc.", "user", 2),
    msg("c-04", "Nice to meet you, Casey.", "assistant", 3),
    msg("c-05", "I prefer event sourcing for audit trails.", "user", 4),
    msg("c-06", "Event sourcing pairs well with PostgreSQL.", "assistant", 5),

    // Post-truncation messages (these would be retained)
    msg("c-07", "What about caching?", "user", 6),
    msg("c-08", "Redis is a common choice for caching.", "assistant", 7),
    msg("c-09", "I need to benchmark the query performance.", "user", 8),
    msg("c-10", "I can help set up benchmarks.", "assistant", 9),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Compaction Preservation E2E", () => {
  it("preserves memories before compaction truncation", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const messages = createCompactionConversation();
    const ctx = compactionContext({ truncationPoint: 6 });

    const result = await hook.onPreCompaction(messages, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Should have extracted and persisted high-value items
    expect(result.value.extractedCount).toBeGreaterThan(0);
    expect(result.value.persistedCount).toBe(result.value.extractedCount);
    expect(result.value.skippedDuplicates).toBe(0);

    // Verify actual saves happened
    expect(memoryService.saved.length).toBe(result.value.persistedCount);

    // Every saved item should have content
    for (const { input } of memoryService.saved) {
      expect(input.content.length).toBeGreaterThan(0);
      expect(input.conversationId).toBe("e2e-conv-compact");
    }
  });

  it("prevents duplicate extraction on compaction retry", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const messages = createCompactionConversation();
    const ctx = compactionContext();

    // First compaction — should extract and persist
    const first = await hook.onPreCompaction(messages, ctx);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const savesAfterFirst = memoryService.saved.length;
    expect(savesAfterFirst).toBeGreaterThan(0);

    // Second compaction with identical messages and context — idempotent
    const second = await hook.onPreCompaction(messages, ctx);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.extractedCount).toBe(0);
    expect(second.value.persistedCount).toBe(0);
    expect(second.value.skippedDuplicates).toBe(1);
    expect(second.value.idempotencyKey).toBe(first.value.idempotencyKey);

    // No additional saves should have occurred
    expect(memoryService.saved.length).toBe(savesAfterFirst);
  });

  it("tags preserved memories with compaction source", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const messages = createCompactionConversation();
    const ctx = compactionContext({
      compactionReason: "context-window-full",
      truncationPoint: 4,
    });

    const result = await hook.onPreCompaction(messages, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(memoryService.saved.length).toBeGreaterThan(0);

    for (const { input } of memoryService.saved) {
      const tags = input.tags ?? [];

      // Compaction source tag
      expect(tags).toContain("source:compaction");

      // Compaction reason tag
      expect(tags).toContain("compaction-reason:context-window-full");

      // Truncation point tag
      expect(tags).toContain("compaction-truncation-point:4");
    }
  });

  it("reports accurate telemetry counts", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const messages = createCompactionConversation();
    const ctx = compactionContext();

    const result = await hook.onPreCompaction(messages, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Telemetry counts should be consistent
    expect(result.value.extractedCount).toBe(result.value.persistedCount);
    expect(result.value.skippedDuplicates).toBe(0);
    expect(result.value.idempotencyKey.length).toBeGreaterThan(0);

    // extractedCount should match actual saves
    expect(result.value.persistedCount).toBe(memoryService.saved.length);

    // Now trigger idempotent retry and check telemetry
    const retry = await hook.onPreCompaction(messages, ctx);
    expect(retry.ok).toBe(true);
    if (!retry.ok) return;

    expect(retry.value.extractedCount).toBe(0);
    expect(retry.value.persistedCount).toBe(0);
    expect(retry.value.skippedDuplicates).toBe(1);
  });

  it("handles compaction of empty message window", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const result = await hook.onPreCompaction([], compactionContext({ truncationPoint: 0 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.extractedCount).toBe(0);
    expect(result.value.persistedCount).toBe(0);
    expect(result.value.skippedDuplicates).toBe(0);
    expect(result.value.idempotencyKey.length).toBeGreaterThan(0);
    expect(memoryService.saved).toHaveLength(0);
  });

  it("extracts from pre-truncation messages only", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    // Only pass pre-truncation messages to the hook (messages before truncation point)
    // This simulates how a compaction manager would call the hook with the
    // messages that are about to be truncated
    const allMessages = createCompactionConversation();
    const truncationPoint = 6;
    const preTruncationMessages = allMessages.slice(0, truncationPoint);

    const ctx = compactionContext({ truncationPoint });

    const result = await hook.onPreCompaction(preTruncationMessages, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All extracted content should come from pre-truncation messages only
    const preTruncationIds = new Set(preTruncationMessages.map((m) => m.id));

    for (const { input } of memoryService.saved) {
      const entities = input.entities ?? [];
      const messageRefs = entities
        .filter((e) => e.startsWith("message:"))
        .map((e) => e.replace("message:", ""));

      // Every message reference should be from pre-truncation messages
      for (const ref of messageRefs) {
        expect(preTruncationIds.has(ref)).toBe(true);
      }
    }

    // Now run with only post-truncation messages (should have fewer or different extractions)
    const postTruncationMessages = allMessages.slice(truncationPoint);
    const postMemoryService = new TrackingMemoryService();
    const postExtractor = new SessionExtractor({ memoryService: postMemoryService });
    const postHook = new MemoryPreservationHook({ sessionExtractor: postExtractor });

    const postResult = await postHook.onPreCompaction(
      postTruncationMessages,
      compactionContext({ truncationPoint, sessionId: "post-session" }),
    );
    expect(postResult.ok).toBe(true);
    if (!postResult.ok) return;

    // Post-truncation messages have an action item ("I need to benchmark...")
    // but the hook filters to high-value categories (decision, fact, preference)
    // so post-truncation should have fewer preserved items than pre-truncation
    expect(postMemoryService.saved.length).toBeLessThan(memoryService.saved.length);
  });

  it("integrates extraction pipeline with provenance tracking", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const hook = new MemoryPreservationHook({ sessionExtractor: extractor });

    const messages = createCompactionConversation();
    const ctx = compactionContext({
      conversationId: "prov-conv-001",
      sessionId: "prov-session-001",
    });

    const result = await hook.onPreCompaction(messages, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(memoryService.saved.length).toBeGreaterThan(0);

    for (const { input } of memoryService.saved) {
      // Conversation ID flows through the entire pipeline
      expect(input.conversationId).toBe("prov-conv-001");

      // Tags carry session provenance
      const tags = input.tags ?? [];
      expect(tags.some((t) => t === "session:prov-session-001")).toBe(true);

      // Tags carry extraction timestamp
      expect(tags.some((t) => t.startsWith("extracted-at:"))).toBe(true);

      // Tags carry extraction version
      expect(tags.some((t) => t.startsWith("extraction-version:"))).toBe(true);

      // Tags carry compaction source metadata
      expect(tags).toContain("source:compaction");

      // Entities carry conversation reference
      const entities = input.entities ?? [];
      expect(entities).toContain("conversation:prov-conv-001");

      // Entities carry message references
      const messageRefs = entities.filter((e) => e.startsWith("message:"));
      expect(messageRefs.length).toBeGreaterThanOrEqual(1);

      // Category tag is present for downstream consumers
      expect(tags.some((t) => t.startsWith("category:"))).toBe(true);

      // Content is non-empty
      expect(input.content.length).toBeGreaterThan(0);

      // Confidence is valid
      expect(input.confidence).toBeGreaterThan(0);
      expect(input.confidence).toBeLessThanOrEqual(1);
    }
  });
});
