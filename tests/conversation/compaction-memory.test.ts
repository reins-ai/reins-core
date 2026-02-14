import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompactionService } from "../../src/conversation/compaction";
import {
  CompactionManager,
  MemoryPreservationHook,
} from "../../src/conversation/compaction/index";
import { ConversationManager } from "../../src/conversation/manager";
import type { CompactionMemoryLogger } from "../../src/conversation/manager";
import { InMemoryConversationStore } from "../../src/conversation/memory-store";
import { SessionRepository } from "../../src/conversation/session-repository";
import { TranscriptStore } from "../../src/conversation/transcript-store";
import type { MemoryStore } from "../../src/memory";
import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "../../src/memory";
import { SessionExtractor, type SessionExtractorMemoryService } from "../../src/memory/capture";
import type { ImplicitMemoryInput } from "../../src/memory/services/memory-service";
import type { MemoryRecord } from "../../src/memory/types";
import { ok, type Result } from "../../src/result";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "compaction-memory-test-"));
  tempDirs.push(dir);
  return dir;
}

async function cleanupTempDirs(): Promise<void> {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
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

class StmMemoryCollector implements SessionExtractorMemoryService {
  public readonly calls: ImplicitMemoryInput[] = [];
  private callCount = 0;

  async saveImplicit(input: ImplicitMemoryInput): Promise<Result<MemoryRecord>> {
    this.callCount += 1;
    this.calls.push(input);
    return ok(createRecord(`stm-mem-${this.callCount}`, input));
  }
}

class SimpleMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async save(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry> {
    const now = new Date();
    const id = `mem_${crypto.randomUUID()}`;
    const next: MemoryEntry = { ...entry, id, createdAt: now, updatedAt: now };
    this.entries.set(id, structuredClone(next));
    return structuredClone(next);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const entry = this.entries.get(id);
    return entry ? structuredClone(entry) : null;
  }

  async search(_options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    return Array.from(this.entries.values()).map((entry) => ({
      entry: structuredClone(entry),
      score: 1,
    }));
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryEntry, "content" | "tags" | "importance" | "expiresAt">>,
  ): Promise<MemoryEntry | null> {
    const existing = this.entries.get(id);
    if (!existing) return null;
    const updated: MemoryEntry = { ...existing, ...updates, updatedAt: new Date() };
    this.entries.set(id, structuredClone(updated));
    return structuredClone(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async deleteByConversation(conversationId: string): Promise<number> {
    let count = 0;
    for (const [id, entry] of this.entries.entries()) {
      if (entry.conversationId === conversationId) {
        this.entries.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}

class LogCollector implements CompactionMemoryLogger {
  public readonly messages: Array<{ level: string; message: string }> = [];

  info(message: string): void {
    this.messages.push({ level: "info", message });
  }

  warn(message: string): void {
    this.messages.push({ level: "warn", message });
  }

  error(message: string): void {
    this.messages.push({ level: "error", message });
  }
}

async function buildManager(options: {
  stmCollector: StmMemoryCollector;
  logger?: LogCollector;
  compactionConfig?: { tokenThreshold?: number; keepRecentMessages?: number; contextWindowTokens?: number };
}) {
  const dir = await createTempDir();
  const store = new InMemoryConversationStore();
  const memoryStore = new SimpleMemoryStore();
  const transcriptStore = new TranscriptStore({ directory: join(dir, "transcripts") });
  const sessionRepository = new SessionRepository({ directory: join(dir, "sessions") });

  const compactionService = new CompactionService({
    config: {
      tokenThreshold: options.compactionConfig?.tokenThreshold ?? 0.1,
      keepRecentMessages: options.compactionConfig?.keepRecentMessages ?? 2,
      contextWindowTokens: options.compactionConfig?.contextWindowTokens ?? 100,
    },
  });

  const sessionExtractor = new SessionExtractor({
    memoryService: options.stmCollector,
  });

  const compactionManager = new CompactionManager();
  const preservationHook = new MemoryPreservationHook({
    sessionExtractor,
  });
  compactionManager.addPreCompactionHook(preservationHook);

  const manager = new ConversationManager(store, sessionRepository, {
    compactionService,
    memoryStore,
    transcriptStore,
    memoryWriteThrough: {
      compactionManager,
      logger: options.logger,
    },
  });

  return { manager, sessionRepository };
}

describe("Compaction memory write-through", () => {
  it("persists extracted facts to STM when compaction triggers", async () => {
    const stmCollector = new StmMemoryCollector();
    const logger = new LogCollector();
    const { manager, sessionRepository } = await buildManager({
      stmCollector,
      logger,
    });

    const session = await sessionRepository.newSession({
      conversationId: "conv-placeholder",
      model: "test-model",
      provider: "test-provider",
    });
    expect(session.ok).toBe(true);

    const conversation = await manager.create({
      model: "test-model",
      provider: "test-provider",
    });

    if (session.ok) {
      await sessionRepository.update(session.value.id, {
        conversationId: conversation.id,
      });
    }

    // Add enough messages to trigger compaction (threshold is very low)
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "I prefer TypeScript for all my projects.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Noted, I will use TypeScript.",
    });
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "I decided to use Bun as the runtime.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Great choice! Bun is fast.",
    });
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "My name is Alex and I work at Acme Corp.",
    });
    // This message should push us over the token threshold and trigger compaction
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Nice to meet you Alex! I will remember that you work at Acme Corp.",
    });

    // Verify STM writes happened
    expect(stmCollector.calls.length).toBeGreaterThan(0);

    // Verify all persisted memories are implicit type with STM-appropriate fields
    for (const call of stmCollector.calls) {
      expect(call.conversationId).toBeTruthy();
      expect(call.confidence).toBeGreaterThan(0);
      expect(call.content).toBeTruthy();
      expect(call.type).toBeTruthy();
    }

    // Verify compaction source tags are present
    const hasCompactionTag = stmCollector.calls.some(
      (call) => call.tags?.includes("source:compaction"),
    );
    expect(hasCompactionTag).toBe(true);

    // Verify logger captured telemetry
    const infoMessages = logger.messages.filter((m) => m.level === "info");
    expect(infoMessages.length).toBeGreaterThanOrEqual(2);
    expect(infoMessages.some((m) => m.message.includes("extracting facts"))).toBe(true);
    expect(infoMessages.some((m) => m.message.includes("write-through complete"))).toBe(true);

    await cleanupTempDirs();
  });

  it("does not write to STM when compaction does not trigger", async () => {
    const stmCollector = new StmMemoryCollector();
    const { manager } = await buildManager({
      stmCollector,
      compactionConfig: {
        tokenThreshold: 0.99,
        keepRecentMessages: 100,
        contextWindowTokens: 100000,
      },
    });

    const conversation = await manager.create({
      model: "test-model",
      provider: "test-provider",
    });

    await manager.addMessage(conversation.id, {
      role: "user",
      content: "I prefer TypeScript.",
    });

    // No compaction should trigger with very high threshold
    expect(stmCollector.calls.length).toBe(0);

    await cleanupTempDirs();
  });

  it("works without memoryWriteThrough configured", async () => {
    const dir = await createTempDir();
    const store = new InMemoryConversationStore();
    const memoryStore = new SimpleMemoryStore();
    const transcriptStore = new TranscriptStore({ directory: join(dir, "transcripts") });
    const sessionRepository = new SessionRepository({ directory: join(dir, "sessions") });

    const compactionService = new CompactionService({
      config: {
        tokenThreshold: 0.1,
        keepRecentMessages: 2,
        contextWindowTokens: 100,
      },
    });

    // No memoryWriteThrough — should not throw
    const manager = new ConversationManager(store, sessionRepository, {
      compactionService,
      memoryStore,
      transcriptStore,
    });

    const session = await sessionRepository.newSession({
      conversationId: "conv-placeholder",
      model: "test-model",
      provider: "test-provider",
    });
    expect(session.ok).toBe(true);

    const conversation = await manager.create({
      model: "test-model",
      provider: "test-provider",
    });

    if (session.ok) {
      await sessionRepository.update(session.value.id, {
        conversationId: conversation.id,
      });
    }

    // Add messages to trigger compaction — should succeed without write-through
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "I prefer TypeScript for all my projects.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Noted, I will use TypeScript.",
    });
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "I decided to use Bun as the runtime.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Great choice! Bun is fast.",
    });
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "My name is Alex.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Nice to meet you Alex!",
    });

    // Should not throw — compaction runs without write-through
    const loaded = await manager.load(conversation.id);
    expect(loaded.messages.length).toBeGreaterThan(0);

    await cleanupTempDirs();
  });

  it("logs warning and continues when write-through hook fails", async () => {
    const failingMemoryService: SessionExtractorMemoryService = {
      async saveImplicit(): Promise<Result<MemoryRecord>> {
        return { ok: false, error: new Error("STM write failed") } as Result<MemoryRecord>;
      },
    };

    const logger = new LogCollector();
    const dir = await createTempDir();
    const store = new InMemoryConversationStore();
    const memoryStore = new SimpleMemoryStore();
    const transcriptStore = new TranscriptStore({ directory: join(dir, "transcripts") });
    const sessionRepository = new SessionRepository({ directory: join(dir, "sessions") });

    const compactionService = new CompactionService({
      config: {
        tokenThreshold: 0.1,
        keepRecentMessages: 2,
        contextWindowTokens: 100,
      },
    });

    const sessionExtractor = new SessionExtractor({
      memoryService: failingMemoryService,
    });

    const compactionManager = new CompactionManager();
    compactionManager.addPreCompactionHook(
      new MemoryPreservationHook({ sessionExtractor }),
    );

    const manager = new ConversationManager(store, sessionRepository, {
      compactionService,
      memoryStore,
      transcriptStore,
      memoryWriteThrough: {
        compactionManager,
        logger,
      },
    });

    const session = await sessionRepository.newSession({
      conversationId: "conv-placeholder",
      model: "test-model",
      provider: "test-provider",
    });
    expect(session.ok).toBe(true);

    const conversation = await manager.create({
      model: "test-model",
      provider: "test-provider",
    });

    if (session.ok) {
      await sessionRepository.update(session.value.id, {
        conversationId: conversation.id,
      });
    }

    // Add messages to trigger compaction
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "I prefer TypeScript for all my projects.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Noted, I will use TypeScript.",
    });
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "I decided to use Bun as the runtime.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Great choice! Bun is fast.",
    });
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "My name is Alex.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Nice to meet you Alex!",
    });

    // Compaction should succeed even though write-through failed
    const loaded = await manager.load(conversation.id);
    expect(loaded.messages.length).toBeGreaterThan(0);

    // Logger should have captured the failure
    const warnMessages = logger.messages.filter((m) => m.level === "warn");
    expect(warnMessages.length).toBeGreaterThan(0);
    expect(warnMessages.some((m) => m.message.includes("write-through failed"))).toBe(true);

    await cleanupTempDirs();
  });

  it("persisted memories include conversation and session context", async () => {
    const stmCollector = new StmMemoryCollector();
    const { manager, sessionRepository } = await buildManager({ stmCollector });

    const session = await sessionRepository.newSession({
      conversationId: "conv-placeholder",
      model: "test-model",
      provider: "test-provider",
    });
    expect(session.ok).toBe(true);

    const conversation = await manager.create({
      model: "test-model",
      provider: "test-provider",
    });

    if (session.ok) {
      await sessionRepository.update(session.value.id, {
        conversationId: conversation.id,
      });
    }

    await manager.addMessage(conversation.id, {
      role: "user",
      content: "I prefer functional programming patterns.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Understood, functional patterns it is.",
    });
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "I decided to use immutable data structures.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Good choice for reliability.",
    });
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "My name is Jordan.",
    });
    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "Hello Jordan!",
    });

    // Verify persisted memories reference the conversation
    for (const call of stmCollector.calls) {
      expect(call.conversationId).toBe(conversation.id);
    }

    await cleanupTempDirs();
  });
});
