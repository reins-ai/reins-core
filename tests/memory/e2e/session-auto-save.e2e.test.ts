import { describe, expect, it } from "bun:test";

import { ok, err, type Result } from "../../../src/result";
import type { Message } from "../../../src/types";
import type { ImplicitMemoryInput } from "../../../src/memory/services/memory-service";
import type { MemoryRecord } from "../../../src/memory/types/index";
import type { MemoryType } from "../../../src/memory/types/memory-types";
import {
  SessionExtractor,
  type SessionExtractorMemoryService,
} from "../../../src/memory/capture/session-extractor";
import type { ExtractionCategory } from "../../../src/memory/capture/extraction-schema";

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

/**
 * In-memory mock that tracks every saveImplicit call for assertion.
 * Supports optional failure injection on a specific call number.
 */
class TrackingMemoryService implements SessionExtractorMemoryService {
  public readonly saved: Array<{ id: string; input: ImplicitMemoryInput }> = [];
  private counter = 0;
  private readonly failOnCall: number | null;

  constructor(options?: { failOnCall?: number }) {
    this.failOnCall = options?.failOnCall ?? null;
  }

  async saveImplicit(input: ImplicitMemoryInput): Promise<Result<MemoryRecord>> {
    this.counter += 1;

    if (this.failOnCall === this.counter) {
      return err(new Error("mock persistence failure"));
    }

    const id = `mem-${this.counter}`;
    const record = createRecord(id, input);
    this.saved.push({ id, input });
    return ok(record);
  }
}

// ---------------------------------------------------------------------------
// Realistic 20-turn conversation fixture
// ---------------------------------------------------------------------------

/**
 * Simulates a realistic 20-message conversation (10 user + 10 assistant turns)
 * covering project setup, technology decisions, personal facts, preferences,
 * action items, and mundane small talk.
 */
function createTwentyTurnConversation(): Message[] {
  return [
    // Turn 1 — greeting (no extractable content)
    msg("m-01", "Hey, can you help me set up a new backend service?", "user", 0),
    msg("m-02", "Sure! What language and runtime are you thinking about?", "assistant", 1),

    // Turn 2 — decision
    msg("m-03", "I'll go with TypeScript on Bun for this project.", "user", 2),
    msg("m-04", "Great choice. Bun has excellent TypeScript support out of the box.", "assistant", 3),

    // Turn 3 — fact (employment)
    msg("m-05", "I work at Acme Corp on the infrastructure team.", "user", 4),
    msg("m-06", "Got it. That context helps me tailor recommendations.", "assistant", 5),

    // Turn 4 — preference
    msg("m-07", "I prefer functional programming over OOP for service logic.", "user", 6),
    msg("m-08", "Functional patterns work well for data pipelines and transformations.", "assistant", 7),

    // Turn 5 — action item
    msg("m-09", "I need to update the deployment docs by Friday.", "user", 8),
    msg("m-10", "I can help draft those docs once the service structure is ready.", "assistant", 9),

    // Turn 6 — clarification (no extractable content)
    msg("m-11", "What folder structure do you recommend?", "user", 10),
    msg("m-12", "A common pattern is src/ with feature-based modules.", "assistant", 11),

    // Turn 7 — another decision
    msg("m-13", "Let's use Hono as the HTTP framework.", "user", 12),
    msg("m-14", "Hono is lightweight and works great with Bun.", "assistant", 13),

    // Turn 8 — fact (identity)
    msg("m-15", "My name is Jordan, by the way.", "user", 14),
    msg("m-16", "Nice to meet you, Jordan!", "assistant", 15),

    // Turn 9 — preference (tooling)
    msg("m-17", "I always run tests before committing code.", "user", 16),
    msg("m-18", "That's a solid practice. We can set up pre-commit hooks.", "assistant", 17),

    // Turn 10 — action item + small talk
    msg("m-19", "TODO: set up CI pipeline with GitHub Actions this week.", "user", 18),
    msg("m-20", "I'll outline the workflow file for you.", "assistant", 19),
  ];
}

/**
 * Creates a conversation with only mundane, non-extractable content.
 */
function createMundaneConversation(): Message[] {
  return [
    msg("m-01", "Hello there.", "user", 0),
    msg("m-02", "Hi! How can I help you today?", "assistant", 1),
    msg("m-03", "Just checking in.", "user", 2),
    msg("m-04", "Sounds good. Let me know if you need anything.", "assistant", 3),
    msg("m-05", "Thanks, that's all for now.", "user", 4),
    msg("m-06", "You're welcome! Have a great day.", "assistant", 5),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Session Auto-Save E2E", () => {
  const SESSION_CONTEXT = {
    sessionId: "e2e-session-001",
    conversationId: "e2e-conv-001",
    timestamp: new Date("2026-02-13T11:00:00.000Z"),
  };

  it("extracts memories from a 20-turn conversation session", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const messages = createTwentyTurnConversation();

    // Step 1: Extract
    const extraction = await extractor.extractFromSession(messages, SESSION_CONTEXT);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    // The conversation contains at least 2 decisions, 2 facts, 2 preferences, 2 action items
    expect(extraction.value.items.length).toBeGreaterThanOrEqual(6);

    // Step 2: Persist
    const persisted = await extractor.persistExtractions(extraction.value);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    // Every extracted item should have been persisted
    expect(persisted.value.length).toBe(extraction.value.items.length);
    expect(memoryService.saved.length).toBe(extraction.value.items.length);

    // Verify each persisted record has a unique ID
    const ids = new Set(persisted.value);
    expect(ids.size).toBe(persisted.value.length);
  });

  it("includes source conversation ID and timestamps in all extracts", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const messages = createTwentyTurnConversation();

    const extraction = await extractor.extractFromSession(messages, SESSION_CONTEXT);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    // ExtractionResult-level provenance
    expect(extraction.value.conversationId).toBe("e2e-conv-001");
    expect(extraction.value.sessionId).toBe("e2e-session-001");
    expect(extraction.value.timestamp).toEqual(SESSION_CONTEXT.timestamp);
    expect(extraction.value.extractionVersion).toBeTruthy();

    // Persist and verify per-item provenance tags
    const persisted = await extractor.persistExtractions(extraction.value);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    for (const { input } of memoryService.saved) {
      // conversationId is set on every persisted input
      expect(input.conversationId).toBe("e2e-conv-001");

      // Tags include session and extraction timestamp
      expect(input.tags).toBeDefined();
      const tags = input.tags ?? [];
      expect(tags.some((t) => t === "session:e2e-session-001")).toBe(true);
      expect(tags.some((t) => t.startsWith("extracted-at:"))).toBe(true);
      expect(tags.some((t) => t.startsWith("extraction-version:"))).toBe(true);

      // Entities include conversation reference
      expect(input.entities).toBeDefined();
      const entities = input.entities ?? [];
      expect(entities.some((e) => e === "conversation:e2e-conv-001")).toBe(true);
    }
  });

  it("categorizes extracts correctly across decisions, facts, preferences, action items", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const messages = createTwentyTurnConversation();

    const extraction = await extractor.extractFromSession(messages, SESSION_CONTEXT);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const categoryCounts = new Map<ExtractionCategory, number>();
    for (const item of extraction.value.items) {
      categoryCounts.set(item.category, (categoryCounts.get(item.category) ?? 0) + 1);
    }

    // Each of these categories should have at least one extraction
    expect(categoryCounts.get("decision")).toBeGreaterThanOrEqual(1);
    expect(categoryCounts.get("fact")).toBeGreaterThanOrEqual(1);
    expect(categoryCounts.get("preference")).toBeGreaterThanOrEqual(1);
    expect(categoryCounts.get("action_item")).toBeGreaterThanOrEqual(1);

    // Verify the persisted memory types map correctly
    await extractor.persistExtractions(extraction.value);

    const typeMap: Record<ExtractionCategory, MemoryType> = {
      decision: "decision",
      preference: "preference",
      fact: "fact",
      action_item: "fact",
      observation: "fact",
    };

    for (const { input } of memoryService.saved) {
      const categoryTag = input.tags?.find((t) => t.startsWith("category:"));
      expect(categoryTag).toBeDefined();
      if (!categoryTag) continue;

      const category = categoryTag.replace("category:", "") as ExtractionCategory;
      expect(input.type).toBe(typeMap[category]);
    }
  });

  it("filters out low-confidence extractions based on threshold", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({
      memoryService,
      config: { confidenceThreshold: 0.95 },
    });

    const messages = createTwentyTurnConversation();
    const extraction = await extractor.extractFromSession(messages, SESSION_CONTEXT);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    // With a very high threshold, only the highest-confidence items survive
    for (const item of extraction.value.items) {
      expect(item.confidence).toBeGreaterThanOrEqual(0.95);
    }

    // Should be fewer items than with default threshold
    const defaultExtractor = new SessionExtractor({ memoryService: new TrackingMemoryService() });
    const defaultExtraction = await defaultExtractor.extractFromSession(messages, SESSION_CONTEXT);
    expect(defaultExtraction.ok).toBe(true);
    if (!defaultExtraction.ok) return;

    expect(extraction.value.items.length).toBeLessThan(defaultExtraction.value.items.length);
  });

  it("handles sessions with no extractable content gracefully", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const messages = createMundaneConversation();

    const extraction = await extractor.extractFromSession(messages, SESSION_CONTEXT);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    expect(extraction.value.items).toHaveLength(0);
    expect(extraction.value.conversationId).toBe("e2e-conv-001");
    expect(extraction.value.sessionId).toBe("e2e-session-001");

    // Persisting an empty extraction should succeed with no saves
    const persisted = await extractor.persistExtractions(extraction.value);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    expect(persisted.value).toEqual([]);
    expect(memoryService.saved).toHaveLength(0);
  });

  it("persists extractions to memory service as STM entries", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const messages = createTwentyTurnConversation();

    const extraction = await extractor.extractFromSession(messages, SESSION_CONTEXT);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    const persisted = await extractor.persistExtractions(extraction.value);
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) return;

    // Every saved record should be an implicit memory with valid confidence
    for (const { input } of memoryService.saved) {
      expect(input.confidence).toBeGreaterThan(0);
      expect(input.confidence).toBeLessThanOrEqual(1);
      expect(input.content.length).toBeGreaterThan(0);
      expect(input.conversationId).toBe("e2e-conv-001");

      // Type should be a valid MemoryType
      const validTypes: MemoryType[] = ["decision", "preference", "fact"];
      expect(validTypes).toContain(input.type);
    }

    // Verify IDs returned match the count of saves
    expect(persisted.value.length).toBe(memoryService.saved.length);
    for (const id of persisted.value) {
      expect(id).toMatch(/^mem-\d+$/);
    }
  });

  it("preserves message ID references for traceability", async () => {
    const memoryService = new TrackingMemoryService();
    const extractor = new SessionExtractor({ memoryService });
    const messages = createTwentyTurnConversation();

    const extraction = await extractor.extractFromSession(messages, SESSION_CONTEXT);
    expect(extraction.ok).toBe(true);
    if (!extraction.ok) return;

    // Every extracted item should reference at least one source message
    for (const item of extraction.value.items) {
      expect(item.sourceMessageIds.length).toBeGreaterThanOrEqual(1);

      // Source message IDs should be from our conversation
      const validIds = new Set(messages.map((m) => m.id));
      for (const sourceId of item.sourceMessageIds) {
        expect(validIds.has(sourceId)).toBe(true);
      }
    }

    // After persistence, entities should include message: references
    await extractor.persistExtractions(extraction.value);

    for (const { input } of memoryService.saved) {
      const entities = input.entities ?? [];
      const messageRefs = entities.filter((e) => e.startsWith("message:"));
      expect(messageRefs.length).toBeGreaterThanOrEqual(1);

      // Each message ref should point to a valid message ID
      for (const ref of messageRefs) {
        const messageId = ref.replace("message:", "");
        const validIds = new Set(messages.map((m) => m.id));
        expect(validIds.has(messageId)).toBe(true);
      }
    }
  });
});
