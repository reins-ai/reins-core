import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompactionService } from "../../src/conversation/compaction";
import { InMemoryConversationStore } from "../../src/conversation/memory-store";
import { SessionRepository } from "../../src/conversation/session-repository";
import { TranscriptStore } from "../../src/conversation/transcript-store";
import { ConversationError } from "../../src/errors";
import type { MemoryStore } from "../../src/memory";
import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "../../src/memory";
import { ok, type Result } from "../../src/result";
import type { Conversation } from "../../src/types";

const tempDirs: string[] = [];

class ControlledMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();
  private pending = 0;
  private persisted = 0;

  async save(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry> {
    const now = new Date();
    const id = `mem_${crypto.randomUUID()}`;
    const next: MemoryEntry = {
      ...entry,
      id,
      createdAt: now,
      updatedAt: now,
    };

    this.pending += 1;
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
    if (!existing) {
      return null;
    }

    const updated: MemoryEntry = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };

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
    this.pending = 0;
    this.persisted = 0;
  }

  async persistNow(): Promise<Result<void, ConversationError>> {
    this.persisted += this.pending;
    this.pending = 0;
    return ok(undefined);
  }

  getPendingWrites(): number {
    return this.pending;
  }

  getPersistedWrites(): number {
    return this.persisted;
  }
}

async function createHarness() {
  const homeDirectory = await mkdtemp(join(tmpdir(), "reins-compaction-"));
  tempDirs.push(homeDirectory);

  const daemonPathOptions = {
    platform: "linux" as const,
    env: {},
    homeDirectory,
  };

  const sessionRepository = new SessionRepository({
    daemonPathOptions,
    defaultModel: "gpt-4o-mini",
    defaultProvider: "openai",
  });
  const transcriptStore = new TranscriptStore({ daemonPathOptions });
  const conversationStore = new InMemoryConversationStore();

  const mainResult = await sessionRepository.getMain();
  if (!mainResult.ok) {
    throw mainResult.error;
  }

  const session = mainResult.value;
  const conversation: Conversation = {
    id: "conv_compaction",
    title: "Compaction Session",
    model: "gpt-4o-mini",
    provider: "openai",
    createdAt: new Date(),
    updatedAt: new Date(),
    messages: [
      {
        id: "msg_1",
        role: "user",
        content: "I prefer concise release notes and decision summaries.",
        createdAt: new Date(),
      },
      {
        id: "msg_2",
        role: "assistant",
        content: "Decision logged: deploy to canary before production rollout.",
        createdAt: new Date(),
      },
      {
        id: "msg_3",
        role: "user",
        content: "Please remember this matters for future restarts.",
        createdAt: new Date(),
      },
      {
        id: "msg_4",
        role: "assistant",
        content: "Acknowledged and prepared checkpoint notes.",
        createdAt: new Date(),
      },
      {
        id: "msg_5",
        role: "user",
        content: "Keep this recent message in active context.",
        createdAt: new Date(),
      },
      {
        id: "msg_6",
        role: "assistant",
        content: "This is the most recent assistant message.",
        createdAt: new Date(),
      },
    ],
  };

  const saveResult = await conversationStore.save(conversation);
  if (!saveResult.ok) {
    throw saveResult.error;
  }

  return {
    conversation,
    conversationStore,
    session,
    sessionRepository,
    transcriptStore,
  };
}

describe("CompactionService", () => {
  afterEach(async () => {
    while (tempDirs.length > 0) {
      const path = tempDirs.pop();
      if (!path) {
        continue;
      }

      await rm(path, { recursive: true, force: true });
    }
  });

  it("triggers compaction when token threshold is exceeded", async () => {
    const { conversation, session } = await createHarness();
    const service = new CompactionService({
      config: {
        contextWindowTokens: 100,
        tokenThreshold: 0.3,
      },
    });

    const shouldCompactResult = service.shouldCompact(session, conversation);
    expect(shouldCompactResult.ok).toBe(true);
    if (!shouldCompactResult.ok) {
      return;
    }

    expect(shouldCompactResult.value).toBe(true);
  });

  it("flushes memory before summary generation and writes transcript markers", async () => {
    const { conversation, conversationStore, session, sessionRepository, transcriptStore } =
      await createHarness();
    const memoryStore = new ControlledMemoryStore();

    const service = new CompactionService({
      config: {
        contextWindowTokens: 100,
        tokenThreshold: 0.3,
        keepRecentMessages: 2,
      },
      summarizer: async (messages) => {
        expect(memoryStore.getPendingWrites()).toBe(0);
        expect(memoryStore.getPersistedWrites()).toBeGreaterThan(0);
        return ok(`Compacted ${messages.length} messages`);
      },
    });

    const result = await service.compact(
      session,
      conversation,
      memoryStore,
      transcriptStore,
      sessionRepository,
      conversationStore,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.compacted).toBe(true);
    expect(result.value.summary).toContain("Compacted");
    expect(result.value.flushedMemories).toBeGreaterThan(0);
    expect(memoryStore.getPendingWrites()).toBe(0);

    const entriesResult = await transcriptStore.read(session.id);
    expect(entriesResult.ok).toBe(true);
    if (!entriesResult.ok) {
      return;
    }

    expect(entriesResult.value).toHaveLength(2);
    expect(entriesResult.value[0]?.type).toBe("memory_flush");
    expect(entriesResult.value[1]?.type).toBe("compaction");
  });

  it("preserves summary plus recent messages and updates session metadata", async () => {
    const { conversation, conversationStore, session, sessionRepository, transcriptStore } =
      await createHarness();
    const memoryStore = new ControlledMemoryStore();

    const service = new CompactionService({
      config: {
        contextWindowTokens: 100,
        tokenThreshold: 0.3,
        keepRecentMessages: 2,
      },
    });

    const compactResult = await service.compact(
      session,
      conversation,
      memoryStore,
      transcriptStore,
      sessionRepository,
      conversationStore,
    );
    expect(compactResult.ok).toBe(true);
    if (!compactResult.ok) {
      return;
    }

    const reloadedConversation = await conversationStore.load(conversation.id);
    expect(reloadedConversation.ok).toBe(true);
    if (!reloadedConversation.ok || !reloadedConversation.value) {
      return;
    }

    expect(reloadedConversation.value.messages).toHaveLength(3);
    expect(reloadedConversation.value.messages[0]?.content).toContain("Conversation summary");
    expect(reloadedConversation.value.messages[1]?.id).toBe("msg_5");
    expect(reloadedConversation.value.messages[2]?.id).toBe("msg_6");

    const updatedSessionResult = await sessionRepository.get(session.id);
    expect(updatedSessionResult.ok).toBe(true);
    if (!updatedSessionResult.ok || !updatedSessionResult.value) {
      return;
    }

    expect(updatedSessionResult.value.status).toBe("active");
    expect(updatedSessionResult.value.lastCompactedAt).toBeDefined();
    expect(updatedSessionResult.value.messageCount).toBe(3);
  });

  it("is a safe no-op when the session is already compacting", async () => {
    const { conversation, conversationStore, session, sessionRepository, transcriptStore } =
      await createHarness();
    const memoryStore = new ControlledMemoryStore();

    const compactingResult = await sessionRepository.update(session.id, {
      status: "compacting",
    });
    expect(compactingResult.ok).toBe(true);
    if (!compactingResult.ok) {
      return;
    }

    const service = new CompactionService({
      config: {
        contextWindowTokens: 100,
        tokenThreshold: 0.3,
      },
    });

    const result = await service.compact(
      compactingResult.value,
      conversation,
      memoryStore,
      transcriptStore,
      sessionRepository,
      conversationStore,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.compacted).toBe(false);

    const entries = await transcriptStore.read(session.id);
    expect(entries.ok).toBe(true);
    if (!entries.ok) {
      return;
    }

    expect(entries.value).toHaveLength(0);
  });
});
