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
import { ok } from "../../src/result";
import { SystemPromptBuilder } from "../../src/persona/builder";
import { EnvironmentContextProvider } from "../../src/persona/environment-context";
import { PersonaRegistry } from "../../src/persona/registry";
import { LocalFileMemoryStore } from "../../src/memory/local-store";
import type { ContentBlock, ToolUseBlock, ToolResultBlock, TextBlock } from "../../src/types";
import type { OverlayResolution } from "../../src/environment/types";

function createOverlayResolution(personality: string, user: string): OverlayResolution {
  const now = new Date();

  return {
    activeEnvironment: "work",
    fallbackEnvironment: "default",
    documents: {
      PERSONALITY: {
        type: "PERSONALITY",
        source: "active",
        sourceEnvironment: "work",
        document: {
          type: "PERSONALITY",
          path: "work/PERSONALITY.md",
          content: personality,
          environmentName: "work",
          loadedAt: now,
        },
      },
      USER: {
        type: "USER",
        source: "active",
        sourceEnvironment: "work",
        document: {
          type: "USER",
          path: "work/USER.md",
          content: user,
          environmentName: "work",
          loadedAt: now,
        },
      },
      HEARTBEAT: {
        type: "HEARTBEAT",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "HEARTBEAT",
          path: "default/HEARTBEAT.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      ROUTINES: {
        type: "ROUTINES",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "ROUTINES",
          path: "default/ROUTINES.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      GOALS: {
        type: "GOALS",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "GOALS",
          path: "default/GOALS.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      KNOWLEDGE: {
        type: "KNOWLEDGE",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "KNOWLEDGE",
          path: "default/KNOWLEDGE.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      TOOLS: {
        type: "TOOLS",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "TOOLS",
          path: "default/TOOLS.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
      BOUNDARIES: {
        type: "BOUNDARIES",
        source: "default",
        sourceEnvironment: "default",
        document: {
          type: "BOUNDARIES",
          path: "default/BOUNDARIES.md",
          content: "",
          environmentName: "default",
          loadedAt: now,
        },
      },
    },
  };
}

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

  test("uses environment-aware system prompt when context provider is configured", async () => {
    const personaRegistry = new PersonaRegistry();
    const provider = new EnvironmentContextProvider(
      {
        getResolvedDocuments: async () =>
          ok(
            createOverlayResolution(
              "You are an environment-specific assistant.",
              "User profile from USER.md",
            ),
          ),
      },
      new SystemPromptBuilder(),
    );
    const manager = new ConversationManager(
      new InMemoryConversationStore(),
      undefined,
      undefined,
      {
        personaRegistry,
        environmentContextProvider: provider,
      },
    );

    const conversation = await manager.create({
      title: "Env Session",
      model: "gpt-4o-mini",
      provider: "openai",
    });

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.role).toBe("system");
    expect(conversation.messages[0]?.content).toContain(
      "## Identity\nYou are an environment-specific assistant.",
    );
    expect(conversation.messages[0]?.content).toContain("## User Context\nUser profile from USER.md");
  });

  test("applies persisted onboarding personality to runtime system prompt", async () => {
    const personaRegistry = new PersonaRegistry();
    const provider = new EnvironmentContextProvider(
      {
        getResolvedDocuments: async () =>
          ok(
            createOverlayResolution(
              "You are an environment-specific assistant.",
              "User profile from USER.md",
            ),
          ),
      },
      new SystemPromptBuilder(),
    );
    const manager = new ConversationManager(
      new InMemoryConversationStore(),
      undefined,
      undefined,
      {
        personaRegistry,
        environmentContextProvider: provider,
        readUserConfig: async () => ok({
          name: "James",
          personality: { preset: "concise" },
          provider: { mode: "none", search: { provider: "brave" } },
          daemon: { host: "localhost", port: 7433 },
          setupComplete: true,
        }),
      },
    );

    const conversation = await manager.create({
      title: "Env Session",
      model: "gpt-4o-mini",
      provider: "openai",
    });

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.content).toContain("## Additional Instructions");
    expect(conversation.messages[0]?.content).toContain("Keep responses brief and to the point");
  });

  test("preserves explicit system prompt when provided", async () => {
    const personaRegistry = new PersonaRegistry();
    const provider = new EnvironmentContextProvider(
      {
        getResolvedDocuments: async () =>
          ok(
            createOverlayResolution(
              "Environment personality should not override explicit prompt",
              "Environment user context",
            ),
          ),
      },
      new SystemPromptBuilder(),
    );
    const manager = new ConversationManager(
      new InMemoryConversationStore(),
      undefined,
      undefined,
      {
        personaRegistry,
        environmentContextProvider: provider,
      },
    );

    const conversation = await manager.create({
      title: "Explicit Session",
      model: "gpt-4o-mini",
      provider: "openai",
      systemPrompt: "Explicit prompt wins",
    });

    expect(conversation.messages).toHaveLength(1);
    expect(conversation.messages[0]?.content).toBe("Explicit prompt wins");
  });

  test("keeps previous behavior when no environment context provider is configured", async () => {
    const manager = new ConversationManager(new InMemoryConversationStore());

    const conversation = await manager.create({
      title: "Legacy Session",
      model: "gpt-4o-mini",
      provider: "openai",
    });

    expect(conversation.messages).toHaveLength(0);
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

describe("ConversationManager - Tool Blocks", () => {
  function createManager() {
    return new ConversationManager(new InMemoryConversationStore());
  }

  async function createConversation(manager: ConversationManager) {
    return manager.create({
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });
  }

  test("adds tool_use block to conversation via addMessage", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const blocks: ContentBlock[] = [
      { type: "text", text: "I'll read the file for you." },
      { type: "tool_use", id: "tool_001", name: "read", input: { path: "README.md" } },
    ];

    const message = await manager.addMessage(conv.id, {
      role: "assistant",
      content: blocks,
    });

    expect(message.role).toBe("assistant");
    expect(Array.isArray(message.content)).toBe(true);

    const content = message.content as ContentBlock[];
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect((content[0] as TextBlock).text).toBe("I'll read the file for you.");
    expect(content[1]?.type).toBe("tool_use");
    expect((content[1] as ToolUseBlock).id).toBe("tool_001");
    expect((content[1] as ToolUseBlock).name).toBe("read");
    expect((content[1] as ToolUseBlock).input).toEqual({ path: "README.md" });
  });

  test("adds tool_result block linked to tool_use", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_002", name: "read", input: { path: "package.json" } },
      ],
    });

    const resultMessage = await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_002", content: '{"name": "reins-core"}' },
      ],
    });

    const content = resultMessage.content as ContentBlock[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("tool_result");
    expect((content[0] as ToolResultBlock).tool_use_id).toBe("tool_002");
    expect((content[0] as ToolResultBlock).content).toBe('{"name": "reins-core"}');
    expect((content[0] as ToolResultBlock).is_error).toBeUndefined();
  });

  test("retrieves conversation history with tool blocks preserved", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    await manager.addMessage(conv.id, { role: "user", content: "Read the README" });
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "text", text: "Reading the file." },
        { type: "tool_use", id: "tool_003", name: "read", input: { path: "README.md" } },
      ],
    });
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_003", content: "# Reins\nA personal assistant." },
      ],
    });
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [{ type: "text", text: "The README describes Reins as a personal assistant." }],
    });

    const history = await manager.getHistory(conv.id);
    expect(history).toHaveLength(4);

    expect(history[0]?.content).toBe("Read the README");
    expect(Array.isArray(history[1]?.content)).toBe(true);
    expect(Array.isArray(history[2]?.content)).toBe(true);
    expect(Array.isArray(history[3]?.content)).toBe(true);

    const assistantBlocks = history[1]?.content as ContentBlock[];
    expect(assistantBlocks[0]?.type).toBe("text");
    expect(assistantBlocks[1]?.type).toBe("tool_use");

    const resultBlocks = history[2]?.content as ContentBlock[];
    expect(resultBlocks[0]?.type).toBe("tool_result");
  });

  test("preserves tool block ordering within a message", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const blocks: ContentBlock[] = [
      { type: "text", text: "Let me check two files." },
      { type: "tool_use", id: "tool_a", name: "read", input: { path: "a.ts" } },
      { type: "tool_use", id: "tool_b", name: "read", input: { path: "b.ts" } },
    ];

    await manager.addMessage(conv.id, { role: "assistant", content: blocks });

    const history = await manager.getHistory(conv.id);
    const content = history[0]?.content as ContentBlock[];

    expect(content).toHaveLength(3);
    expect(content[0]?.type).toBe("text");
    expect(content[1]?.type).toBe("tool_use");
    expect((content[1] as ToolUseBlock).id).toBe("tool_a");
    expect(content[2]?.type).toBe("tool_use");
    expect((content[2] as ToolUseBlock).id).toBe("tool_b");
  });

  test("handles multiple tool calls in sequence", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    await manager.addMessage(conv.id, { role: "user", content: "Find and read the config" });

    // First tool call
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_10", name: "glob", input: { pattern: "*.config.*" } },
      ],
    });
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_10", content: "tsconfig.json\nvite.config.ts" },
      ],
    });

    // Second tool call
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_11", name: "read", input: { path: "tsconfig.json" } },
      ],
    });
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_11", content: '{"compilerOptions":{}}' },
      ],
    });

    // Final synthesis
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [{ type: "text", text: "Found two config files." }],
    });

    const history = await manager.getHistory(conv.id);
    expect(history).toHaveLength(6);
    expect(history[0]?.role).toBe("user");
    expect(history[1]?.role).toBe("assistant");
    expect(history[2]?.role).toBe("user");
    expect(history[3]?.role).toBe("assistant");
    expect(history[4]?.role).toBe("user");
    expect(history[5]?.role).toBe("assistant");
  });

  test("handles multiple parallel tool calls before results", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    await manager.addMessage(conv.id, { role: "user", content: "Read both files" });

    // Assistant requests two tools at once
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "text", text: "Reading both files." },
        { type: "tool_use", id: "tool_p1", name: "read", input: { path: "a.ts" } },
        { type: "tool_use", id: "tool_p2", name: "read", input: { path: "b.ts" } },
      ],
    });

    // Both results come back in one user message
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_p1", content: "content of a.ts" },
        { type: "tool_result", tool_use_id: "tool_p2", content: "content of b.ts" },
      ],
    });

    const history = await manager.getHistory(conv.id);
    expect(history).toHaveLength(3);

    const resultBlocks = history[2]?.content as ContentBlock[];
    expect(resultBlocks).toHaveLength(2);
    expect((resultBlocks[0] as ToolResultBlock).tool_use_id).toBe("tool_p1");
    expect((resultBlocks[1] as ToolResultBlock).tool_use_id).toBe("tool_p2");
  });

  test("mixed text and tool blocks in single message", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const blocks: ContentBlock[] = [
      { type: "text", text: "First, let me search." },
      { type: "tool_use", id: "tool_mix", name: "grep", input: { pattern: "TODO", include: "*.ts" } },
    ];

    const message = await manager.addMessage(conv.id, {
      role: "assistant",
      content: blocks,
    });

    const content = message.content as ContentBlock[];
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]?.type).toBe("tool_use");
    expect((content[1] as ToolUseBlock).input).toEqual({ pattern: "TODO", include: "*.ts" });
  });

  test("tool blocks survive serialization roundtrip through store", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const toolUseBlocks: ContentBlock[] = [
      { type: "tool_use", id: "tool_rt", name: "bash", input: { command: "echo hello" } },
    ];
    const toolResultBlocks: ContentBlock[] = [
      { type: "tool_result", tool_use_id: "tool_rt", content: "hello\n" },
    ];

    await manager.addMessage(conv.id, { role: "assistant", content: toolUseBlocks });
    await manager.addMessage(conv.id, { role: "user", content: toolResultBlocks });

    // Load from store (InMemoryConversationStore uses structuredClone)
    const loaded = await manager.load(conv.id);
    const assistantContent = loaded.messages[0]?.content as ContentBlock[];
    const userContent = loaded.messages[1]?.content as ContentBlock[];

    expect(assistantContent[0]?.type).toBe("tool_use");
    expect((assistantContent[0] as ToolUseBlock).id).toBe("tool_rt");
    expect((assistantContent[0] as ToolUseBlock).name).toBe("bash");
    expect((assistantContent[0] as ToolUseBlock).input).toEqual({ command: "echo hello" });

    expect(userContent[0]?.type).toBe("tool_result");
    expect((userContent[0] as ToolResultBlock).tool_use_id).toBe("tool_rt");
    expect((userContent[0] as ToolResultBlock).content).toBe("hello\n");
  });

  test("tool call IDs preserved through history retrieval", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const toolId = "toolu_01AbCdEf123456";
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: toolId, name: "read", input: { path: "test.ts" } },
      ],
    });
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: toolId, content: "file content" },
      ],
    });

    const history = await manager.getHistory(conv.id);
    const useBlock = (history[0]?.content as ContentBlock[])[0] as ToolUseBlock;
    const resultBlock = (history[1]?.content as ContentBlock[])[0] as ToolResultBlock;

    expect(useBlock.id).toBe(toolId);
    expect(resultBlock.tool_use_id).toBe(toolId);
  });

  test("complex tool arguments preserved", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const complexInput = {
      command: "bun test",
      timeout: 30000,
      env: { NODE_ENV: "test", DEBUG: "true" },
      flags: ["--verbose", "--coverage"],
      nested: { deep: { value: 42 } },
    };

    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_complex", name: "bash", input: complexInput },
      ],
    });

    const history = await manager.getHistory(conv.id);
    const block = (history[0]?.content as ContentBlock[])[0] as ToolUseBlock;
    expect(block.input).toEqual(complexInput);
  });

  test("error flag preserved in tool results", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_err", name: "bash", input: { command: "exit 1" } },
      ],
    });
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_err", content: "Command failed with exit code 1", is_error: true },
      ],
    });

    const history = await manager.getHistory(conv.id);
    const resultBlock = (history[1]?.content as ContentBlock[])[0] as ToolResultBlock;
    expect(resultBlock.is_error).toBe(true);
    expect(resultBlock.content).toBe("Command failed with exit code 1");
  });

  test("tool result without matching tool_use (orphaned result)", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    // Add orphaned tool result — no prior tool_use with this ID
    const message = await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "nonexistent_tool", content: "orphaned result" },
      ],
    });

    expect(message.role).toBe("user");
    const content = message.content as ContentBlock[];
    expect(content[0]?.type).toBe("tool_result");
    expect((content[0] as ToolResultBlock).tool_use_id).toBe("nonexistent_tool");
  });

  test("empty tool input", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_empty", name: "ls", input: {} },
      ],
    });

    const history = await manager.getHistory(conv.id);
    const block = (history[0]?.content as ContentBlock[])[0] as ToolUseBlock;
    expect(block.input).toEqual({});
  });

  test("large tool output preserved", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const largeOutput = "x".repeat(100_000);

    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_large", name: "read", input: { path: "big.txt" } },
      ],
    });
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_large", content: largeOutput },
      ],
    });

    const history = await manager.getHistory(conv.id);
    const resultBlock = (history[1]?.content as ContentBlock[])[0] as ToolResultBlock;
    expect(resultBlock.content).toBe(largeOutput);
    expect(resultBlock.content.length).toBe(100_000);
  });

  test("addToolUseMessage convenience method", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const toolUseBlocks: ToolUseBlock[] = [
      { type: "tool_use", id: "tool_conv1", name: "read", input: { path: "src/index.ts" } },
    ];

    const message = await manager.addToolUseMessage(
      conv.id,
      toolUseBlocks,
      "Let me read that file.",
    );

    expect(message.role).toBe("assistant");
    const content = message.content as ContentBlock[];
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect((content[0] as TextBlock).text).toBe("Let me read that file.");
    expect(content[1]?.type).toBe("tool_use");
    expect((content[1] as ToolUseBlock).id).toBe("tool_conv1");
  });

  test("addToolUseMessage without text prefix", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const toolUseBlocks: ToolUseBlock[] = [
      { type: "tool_use", id: "tool_conv2", name: "bash", input: { command: "ls" } },
    ];

    const message = await manager.addToolUseMessage(conv.id, toolUseBlocks);

    const content = message.content as ContentBlock[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("tool_use");
  });

  test("addToolResult convenience method", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_res1", name: "read", input: { path: "test.ts" } },
      ],
    });

    const resultMessage = await manager.addToolResult(conv.id, "tool_res1", "file contents here");

    expect(resultMessage.role).toBe("user");
    const content = resultMessage.content as ContentBlock[];
    expect(content).toHaveLength(1);
    expect(content[0]?.type).toBe("tool_result");
    expect((content[0] as ToolResultBlock).tool_use_id).toBe("tool_res1");
    expect((content[0] as ToolResultBlock).content).toBe("file contents here");
    expect((content[0] as ToolResultBlock).is_error).toBeUndefined();
  });

  test("addToolResult with error flag", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const resultMessage = await manager.addToolResult(
      conv.id,
      "tool_err2",
      "Permission denied",
      true,
    );

    const content = resultMessage.content as ContentBlock[];
    expect((content[0] as ToolResultBlock).is_error).toBe(true);
    expect((content[0] as ToolResultBlock).content).toBe("Permission denied");
  });

  test("full tool-use roundtrip conversation flow", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    // User asks a question
    await manager.addMessage(conv.id, { role: "user", content: "Read the README file" });

    // Assistant decides to use a tool
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "text", text: "I'll read the README for you." },
        { type: "tool_use", id: "tool_123", name: "read", input: { path: "README.md" } },
      ],
    });

    // Tool result comes back
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_123", content: "# README\nThis is the readme content." },
      ],
    });

    // Assistant synthesizes
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "text", text: "Here's what the README says: it describes the project." },
      ],
    });

    // Verify full roundtrip
    const history = await manager.getHistory(conv.id);
    expect(history).toHaveLength(4);

    // Message 1: plain text user message
    expect(history[0]?.role).toBe("user");
    expect(typeof history[0]?.content).toBe("string");
    expect(history[0]?.content).toBe("Read the README file");

    // Message 2: assistant with text + tool_use
    expect(history[1]?.role).toBe("assistant");
    const msg2 = history[1]?.content as ContentBlock[];
    expect(msg2).toHaveLength(2);
    expect(msg2[0]?.type).toBe("text");
    expect(msg2[1]?.type).toBe("tool_use");
    expect((msg2[1] as ToolUseBlock).id).toBe("tool_123");

    // Message 3: tool result
    expect(history[2]?.role).toBe("user");
    const msg3 = history[2]?.content as ContentBlock[];
    expect(msg3).toHaveLength(1);
    expect(msg3[0]?.type).toBe("tool_result");
    expect((msg3[0] as ToolResultBlock).tool_use_id).toBe("tool_123");

    // Message 4: assistant synthesis
    expect(history[3]?.role).toBe("assistant");
    const msg4 = history[3]?.content as ContentBlock[];
    expect(msg4).toHaveLength(1);
    expect(msg4[0]?.type).toBe("text");
  });

  test("completeAssistantMessage accepts ContentBlock array", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    const sendResult = await manager.sendMessage({
      conversationId: conv.id,
      content: "Help me read a file",
    });

    const blocks: ContentBlock[] = [
      { type: "text", text: "Reading the file now." },
      { type: "tool_use", id: "tool_complete", name: "read", input: { path: "src/index.ts" } },
    ];

    await manager.completeAssistantMessage({
      conversationId: conv.id,
      assistantMessageId: sendResult.assistantMessageId,
      content: blocks,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
    });

    const loaded = await manager.load(conv.id);
    const assistantMsg = loaded.messages.find((m) => m.id === sendResult.assistantMessageId);
    expect(assistantMsg).toBeDefined();
    expect(Array.isArray(assistantMsg?.content)).toBe(true);

    const content = assistantMsg?.content as ContentBlock[];
    expect(content).toHaveLength(2);
    expect(content[0]?.type).toBe("text");
    expect(content[1]?.type).toBe("tool_use");
  });

  test("generateTitle handles ContentBlock array in user messages", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    // User message with tool result blocks (edge case)
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_x", content: "some result" },
      ],
    });

    const loaded = await manager.load(conv.id);
    const title = manager.generateTitle(loaded);
    // No text blocks, so falls back to default
    expect(title).toBe("New Conversation");
  });

  test("fork preserves tool blocks in copied messages", async () => {
    const manager = createManager();
    const conv = await createConversation(manager);

    await manager.addMessage(conv.id, { role: "user", content: "Read file" });
    await manager.addMessage(conv.id, {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tool_fork", name: "read", input: { path: "test.ts" } },
      ],
    });
    await manager.addMessage(conv.id, {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tool_fork", content: "test content" },
      ],
    });

    const forked = await manager.fork(conv.id);
    expect(forked.messages).toHaveLength(3);

    const forkedAssistant = forked.messages[1]?.content as ContentBlock[];
    expect(forkedAssistant[0]?.type).toBe("tool_use");
    expect((forkedAssistant[0] as ToolUseBlock).id).toBe("tool_fork");

    const forkedResult = forked.messages[2]?.content as ContentBlock[];
    expect(forkedResult[0]?.type).toBe("tool_result");
    expect((forkedResult[0] as ToolResultBlock).tool_use_id).toBe("tool_fork");

    // Verify forked messages have new IDs
    expect(forked.messages[1]?.id).not.toBe((await manager.getHistory(conv.id))[1]?.id);
  });
});
