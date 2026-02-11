import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationManager, InMemoryConversationStore, SessionRepository, TranscriptStore } from "../../src/conversation";
import { ConversationError } from "../../src/errors";
import { InMemoryMemoryStore } from "../../src/memory";

describe("integration/persistence", () => {
  it("persists conversations across managers and keeps forked history independent", async () => {
    const store = new InMemoryConversationStore();
    const managerA = new ConversationManager(store);

    const conversation = await managerA.create({
      title: "Persistence",
      model: "mock-model-1",
      provider: "mock-provider",
    });

    await managerA.addMessage(conversation.id, { role: "user", content: "First" });
    await managerA.addMessage(conversation.id, { role: "assistant", content: "Second" });

    const managerB = new ConversationManager(store);
    const loaded = await managerB.load(conversation.id);

    expect(loaded.messages.map((message) => message.content)).toEqual(["First", "Second"]);

    const forked = await managerB.fork(conversation.id, { title: "Forked" });
    await managerB.addMessage(forked.id, { role: "user", content: "Fork-only message" });

    const originalReloaded = await managerA.load(conversation.id);
    const forkReloaded = await managerA.load(forked.id);

    expect(originalReloaded.messages.map((message) => message.content)).toEqual(["First", "Second"]);
    expect(forkReloaded.messages.map((message) => message.content)).toEqual([
      "First",
      "Second",
      "Fork-only message",
    ]);
  });

  it("persists memories, supports search, and keeps memory after conversation deletion", async () => {
    const conversationStore = new InMemoryConversationStore();
    const manager = new ConversationManager(conversationStore);
    const memoryStore = new InMemoryMemoryStore();

    const conversation = await manager.create({
      title: "Memory",
      model: "mock-model-1",
      provider: "mock-provider",
    });

    await manager.addMessage(conversation.id, {
      role: "user",
      content: "Remember that I prefer concise summaries",
    });

    await memoryStore.save({
      content: "User prefers concise summaries",
      type: "preference",
      tags: ["style", "summary"],
      importance: 0.9,
      conversationId: conversation.id,
    });
    await memoryStore.save({
      content: "Discussed weather planning",
      type: "context",
      tags: ["weather"],
      importance: 0.4,
      conversationId: conversation.id,
    });

    const byContent = await memoryStore.search({ query: "concise" });
    const byTag = await memoryStore.search({ tags: ["style"] });
    const byType = await memoryStore.search({ type: "preference" });

    expect(byContent).toHaveLength(1);
    expect(byTag).toHaveLength(1);
    expect(byType).toHaveLength(1);
    expect(byType[0]?.entry.conversationId).toBe(conversation.id);

    expect(await manager.delete(conversation.id)).toBe(true);

    const stillPresent = await memoryStore.search({ query: "concise" });
    expect(stillPresent).toHaveLength(1);
    expect(stillPresent[0]?.entry.content).toContain("concise");

    await expect(manager.load(conversation.id)).rejects.toBeInstanceOf(ConversationError);
  });

  it("persists session metadata and transcript replay across restart simulation", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "reins-persist-"));

    try {
      const daemonPathOptions = {
        platform: "linux" as const,
        env: {},
        homeDirectory,
      };

      const firstSessionRepository = new SessionRepository({
        daemonPathOptions,
        defaultModel: "gpt-4o-mini",
        defaultProvider: "openai",
      });
      const firstTranscriptStore = new TranscriptStore({ daemonPathOptions });

      const mainResult = await firstSessionRepository.getMain();
      expect(mainResult.ok).toBe(true);
      if (!mainResult.ok) {
        return;
      }

      const sessionId = mainResult.value.id;
      const appendResult = await firstTranscriptStore.appendBatch(sessionId, [
        {
          type: "session_start",
          timestamp: "2026-02-11T15:00:00.000Z",
          sessionId,
        },
        {
          type: "message",
          timestamp: "2026-02-11T15:00:01.000Z",
          role: "user",
          content: "Will this survive restart?",
          messageId: "msg_restart_user",
        },
      ]);
      expect(appendResult.ok).toBe(true);

      const syncResult = await firstTranscriptStore.sync(sessionId);
      expect(syncResult.ok).toBe(true);

      const restartedSessionRepository = new SessionRepository({
        daemonPathOptions,
        defaultModel: "gpt-4o-mini",
        defaultProvider: "openai",
      });
      const restartedTranscriptStore = new TranscriptStore({ daemonPathOptions });

      const resumedMain = await restartedSessionRepository.getMain();
      expect(resumedMain.ok).toBe(true);
      if (!resumedMain.ok) {
        return;
      }

      expect(resumedMain.value.id).toBe(sessionId);

      const repaired = await restartedTranscriptStore.repair(sessionId);
      expect(repaired.ok).toBe(true);

      const replayed = await restartedTranscriptStore.read(sessionId);
      expect(replayed.ok).toBe(true);
      if (!replayed.ok) {
        return;
      }

      expect(replayed.value.map((entry) => entry.type)).toEqual(["session_start", "message"]);
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});
