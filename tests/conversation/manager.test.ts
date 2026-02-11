import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CompactionService } from "../../src/conversation/compaction";
import { ConversationError } from "../../src/errors";
import { ConversationManager } from "../../src/conversation/manager";
import { SessionRepository } from "../../src/conversation/session-repository";
import { TranscriptStore } from "../../src/conversation/transcript-store";
import { InMemoryConversationStore } from "../../src/conversation/memory-store";
import { LocalFileMemoryStore } from "../../src/memory/local-store";

describe("ConversationManager", () => {
  test("creates conversations with system prompt and options", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());

    const conversation = await manager.create({
      title: "Session",
      model: "gpt-4o-mini",
      provider: "openai",
      personaId: "persona-1",
      workspaceId: "ws-1",
      systemPrompt: "You are helpful",
    });

    expect(conversation.id.startsWith("conv_")).toBe(true);
    expect(conversation.title).toBe("Session");
    expect(conversation.model).toBe("gpt-4o-mini");
    expect(conversation.provider).toBe("openai");
    expect(conversation.personaId).toBe("persona-1");
    expect(conversation.workspaceId).toBe("ws-1");
    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.role).toBe("system");
    expect(conversation.messages[0]?.content).toBe("You are helpful");
  });

  test("loads existing conversations and throws for missing ones", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const created = await manager.create({
      model: "gpt-4o-mini",
      provider: "openai",
    });

    const loaded = await manager.load(created.id);
    expect(loaded.id).toBe(created.id);

    await expect(manager.load("missing-conversation")).rejects.toBeInstanceOf(ConversationError);
  });

  test("adds messages and updates updatedAt", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const created = await manager.create({
      model: "gpt-4o-mini",
      provider: "openai",
    });
    const initialUpdatedAt = created.updatedAt;

    await Bun.sleep(2);

    const message = await manager.addMessage(created.id, {
      role: "user",
      content: "Hello world",
    });

    expect(message.id.startsWith("msg_")).toBe(true);
    expect(message.role).toBe("user");
    expect(message.content).toBe("Hello world");

    const loaded = await manager.load(created.id);
    expect(loaded.messages).toHaveLength(1);
    expect(loaded.updatedAt.getTime()).toBeGreaterThan(initialUpdatedAt.getTime());
  });

  test("returns history in chronological order with filters", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const created = await manager.create({
      model: "gpt-4o-mini",
      provider: "openai",
    });

    const first = await manager.addMessage(created.id, { role: "user", content: "first" });
    await Bun.sleep(2);
    const second = await manager.addMessage(created.id, { role: "assistant", content: "second" });
    await Bun.sleep(2);
    await manager.addMessage(created.id, { role: "user", content: "third" });

    const all = await manager.getHistory(created.id);
    expect(all.map((message) => message.content)).toEqual(["first", "second", "third"]);

    const byRole = await manager.getHistory(created.id, { roles: ["assistant"] });
    expect(byRole.map((message) => message.content)).toEqual(["second"]);

    const beforeSecond = await manager.getHistory(created.id, { before: second.createdAt });
    expect(beforeSecond.map((message) => message.content)).toEqual(["first"]);

    const limited = await manager.getHistory(created.id, { limit: 2 });
    expect(limited.map((message) => message.content)).toEqual(["second", "third"]);

    expect(first.createdAt.getTime()).toBeLessThan(second.createdAt.getTime());
  });

  test("forks with and without upToMessageId", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const created = await manager.create({
      title: "Original",
      model: "gpt-4o-mini",
      provider: "openai",
    });

    const first = await manager.addMessage(created.id, { role: "user", content: "first" });
    await manager.addMessage(created.id, { role: "assistant", content: "second" });

    const fullFork = await manager.fork(created.id);
    expect(fullFork.id).not.toBe(created.id);
    expect(fullFork.title).toBe("Original (Fork)");
    expect(fullFork.messages).toHaveLength(2);
    expect(fullFork.messages[0]?.id).not.toBe(first.id);

    const partialFork = await manager.fork(created.id, {
      upToMessageId: first.id,
      title: "Branch",
    });
    expect(partialFork.title).toBe("Branch");
    expect(partialFork.messages).toHaveLength(1);
    expect(partialFork.messages[0]?.content).toBe("first");

    await expect(
      manager.fork(created.id, {
        upToMessageId: "missing-message",
      }),
    ).rejects.toBeInstanceOf(ConversationError);
  });

  test("deletes conversations", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());
    const created = await manager.create({
      model: "gpt-4o-mini",
      provider: "openai",
    });

    expect(await manager.delete(created.id)).toBe(true);
    expect(await manager.delete(created.id)).toBe(false);
  });

  test("generates title from first user message", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());

    const emptyConversation = await manager.create({
      model: "gpt-4o-mini",
      provider: "openai",
    });
    expect(manager.generateTitle(emptyConversation)).toBe("New Conversation");

    await manager.addMessage(emptyConversation.id, {
      role: "assistant",
      content: "not a user message",
    });
    await manager.addMessage(emptyConversation.id, {
      role: "user",
      content:
        "This is a very long first user message that should be truncated to fifty characters",
    });

    const loaded = await manager.load(emptyConversation.id);
    const generated = manager.generateTitle(loaded);

    expect(generated.length).toBeLessThanOrEqual(50);
    expect(generated).toBe("This is a very long first user message that should");
  });

  test("runs compaction inline after addMessage when threshold is exceeded", async () => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "reins-manager-compaction-"));

    try {
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
      const memoryStore = new LocalFileMemoryStore(join(homeDirectory, "memory", "entries.json"));
      const compactionService = new CompactionService({
        config: {
          contextWindowTokens: 100,
          tokenThreshold: 0.3,
          keepRecentMessages: 2,
        },
      });

      const manager = new ConversationManager(
        new InMemoryConversationStore(),
        sessionRepository,
        {
          compactionService,
          memoryStore,
          transcriptStore,
        },
      );

      const conversation = await manager.create({
        model: "gpt-4o-mini",
        provider: "openai",
      });

      await manager.addMessage(conversation.id, {
        role: "user",
        content: "I prefer concise summaries and want decisions preserved.",
      });
      await manager.addMessage(conversation.id, {
        role: "assistant",
        content: "Decision noted: rollout must happen in canary first.",
      });
      await manager.addMessage(conversation.id, {
        role: "user",
        content: "Please keep this context durable across restarts.",
      });

      const compactedConversation = await manager.load(conversation.id);
      expect(compactedConversation.messages[0]?.content).toContain("Conversation summary");

      const mainResult = await sessionRepository.getMain();
      expect(mainResult.ok).toBe(true);
      if (!mainResult.ok) {
        return;
      }

      const transcript = await transcriptStore.read(mainResult.value.id);
      expect(transcript.ok).toBe(true);
      if (!transcript.ok) {
        return;
      }

      expect(transcript.value.map((entry) => entry.type)).toEqual(["memory_flush", "compaction"]);
      expect(mainResult.value.status).toBe("active");
      expect(mainResult.value.lastCompactedAt).toBeDefined();
    } finally {
      await rm(homeDirectory, { recursive: true, force: true });
    }
  });
});
