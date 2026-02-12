import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationManager, InMemoryConversationStore, SQLiteConversationStore, SessionRepository, TranscriptStore } from "../../src/conversation";
import { ConversationError } from "../../src/errors";
import { InMemoryMemoryStore } from "../../src/memory";
import { BYOKAnthropicProvider } from "../../src/providers/byok/anthropic";
import type { ContentBlock, Message, ToolUseBlock, ToolResultBlock } from "../../src/types/conversation";
import type { ChatRequest } from "../../src/types/provider";

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

describe("integration/persistence - resume with tool context", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeToolUseBlocks(): ToolUseBlock[] {
    return [
      {
        type: "tool_use",
        id: "toolu_read_1",
        name: "read",
        input: { path: "src/index.ts", offset: 1, limit: 50 },
      },
    ];
  }

  function makeToolResultBlock(): ToolResultBlock {
    return {
      type: "tool_result",
      tool_use_id: "toolu_read_1",
      content: "1: export function main() {\n2:   console.log('hello');\n3: }",
    };
  }

  function buildConversationWithToolHistory(): Message[] {
    const now = new Date();
    return [
      {
        id: "msg-user-1",
        role: "user",
        content: "Read the main file",
        createdAt: now,
      },
      {
        id: "msg-assistant-1",
        role: "assistant",
        content: [
          { type: "text", text: "I'll read the file for you." },
          ...makeToolUseBlocks(),
        ],
        createdAt: now,
      },
      {
        id: "msg-tool-result-1",
        role: "user",
        content: [makeToolResultBlock()],
        createdAt: now,
      },
      {
        id: "msg-assistant-2",
        role: "assistant",
        content: "The file contains a main function that logs 'hello'.",
        createdAt: now,
      },
    ];
  }

  it("Anthropic provider maps tool_use blocks in resumed conversation history", () => {
    let capturedBody: string | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_resume_1",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "I can see the previous file content." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 20 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });
    const messages = buildConversationWithToolHistory();

    const request: ChatRequest = {
      model: "claude-3-5-sonnet-latest",
      messages,
    };

    return provider.chat(request).then((response) => {
      expect(response.content).toBe("I can see the previous file content.");

      const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
      const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

      expect(apiMessages).toHaveLength(4);

      // First message: plain text user message
      expect(apiMessages[0].role).toBe("user");
      expect(apiMessages[0].content).toBe("Read the main file");

      // Second message: assistant with text + tool_use blocks
      expect(apiMessages[1].role).toBe("assistant");
      const assistantContent = apiMessages[1].content as Array<Record<string, unknown>>;
      expect(Array.isArray(assistantContent)).toBe(true);
      expect(assistantContent).toHaveLength(2);
      expect(assistantContent[0].type).toBe("text");
      expect(assistantContent[0].text).toBe("I'll read the file for you.");
      expect(assistantContent[1].type).toBe("tool_use");
      expect(assistantContent[1].id).toBe("toolu_read_1");
      expect(assistantContent[1].name).toBe("read");
      expect(assistantContent[1].input).toEqual({ path: "src/index.ts", offset: 1, limit: 50 });

      // Third message: user with tool_result block
      expect(apiMessages[2].role).toBe("user");
      const toolResultContent = apiMessages[2].content as Array<Record<string, unknown>>;
      expect(Array.isArray(toolResultContent)).toBe(true);
      expect(toolResultContent).toHaveLength(1);
      expect(toolResultContent[0].type).toBe("tool_result");
      expect(toolResultContent[0].tool_use_id).toBe("toolu_read_1");
      expect(toolResultContent[0].content).toContain("export function main");

      // Fourth message: plain text assistant response
      expect(apiMessages[3].role).toBe("assistant");
      expect(apiMessages[3].content).toBe("The file contains a main function that logs 'hello'.");
    });
  });

  it("Anthropic provider maps tool_result with is_error flag", () => {
    let capturedBody: string | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_err_1",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "The tool failed." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });
    const now = new Date();

    const messages: Message[] = [
      { id: "msg-1", role: "user", content: "Run a command", createdAt: now },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_bash_1",
            name: "bash",
            input: { command: "rm -rf /" },
          },
        ],
        createdAt: now,
      },
      {
        id: "msg-3",
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_bash_1",
            content: "Command rejected: banned command",
            is_error: true,
          },
        ],
        createdAt: now,
      },
    ];

    return provider.chat({ model: "claude-3-5-sonnet-latest", messages }).then(() => {
      const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
      const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

      const toolResultMsg = apiMessages[2].content as Array<Record<string, unknown>>;
      expect(toolResultMsg[0].is_error).toBe(true);
      expect(toolResultMsg[0].tool_use_id).toBe("toolu_bash_1");
    });
  });

  it("Anthropic provider handles multiple tool calls in sequence", () => {
    let capturedBody: string | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_multi_1",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "Done." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 200, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });
    const now = new Date();

    const messages: Message[] = [
      { id: "msg-1", role: "user", content: "Find and read the config", createdAt: now },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_glob_1", name: "glob", input: { pattern: "**/*.config.ts" } },
          { type: "tool_use", id: "toolu_read_1", name: "read", input: { path: "tsconfig.json" } },
        ],
        createdAt: now,
      },
      {
        id: "msg-3",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_glob_1", content: "tsconfig.json\nvite.config.ts" },
          { type: "tool_result", tool_use_id: "toolu_read_1", content: '{"compilerOptions":{}}' },
        ],
        createdAt: now,
      },
      {
        id: "msg-4",
        role: "assistant",
        content: "Found the config files.",
        createdAt: now,
      },
    ];

    return provider.chat({ model: "claude-3-5-sonnet-latest", messages }).then(() => {
      const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
      const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

      expect(apiMessages).toHaveLength(4);

      // Assistant message with parallel tool calls
      const assistantBlocks = apiMessages[1].content as Array<Record<string, unknown>>;
      expect(assistantBlocks).toHaveLength(2);
      expect(assistantBlocks[0].type).toBe("tool_use");
      expect(assistantBlocks[0].name).toBe("glob");
      expect(assistantBlocks[1].type).toBe("tool_use");
      expect(assistantBlocks[1].name).toBe("read");

      // User message with parallel tool results
      const resultBlocks = apiMessages[2].content as Array<Record<string, unknown>>;
      expect(resultBlocks).toHaveLength(2);
      expect(resultBlocks[0].type).toBe("tool_result");
      expect(resultBlocks[0].tool_use_id).toBe("toolu_glob_1");
      expect(resultBlocks[1].type).toBe("tool_result");
      expect(resultBlocks[1].tool_use_id).toBe("toolu_read_1");
    });
  });

  it("Anthropic provider preserves plain string content for text-only messages", () => {
    let capturedBody: string | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_text_1",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "Hi" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });
    const now = new Date();

    const messages: Message[] = [
      { id: "msg-1", role: "user", content: "Hello", createdAt: now },
      { id: "msg-2", role: "assistant", content: "Hi there", createdAt: now },
      { id: "msg-3", role: "user", content: "How are you?", createdAt: now },
    ];

    return provider.chat({ model: "claude-3-5-sonnet-latest", messages }).then(() => {
      const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
      const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

      expect(apiMessages).toHaveLength(3);
      expect(apiMessages[0].content).toBe("Hello");
      expect(typeof apiMessages[0].content).toBe("string");
      expect(apiMessages[1].content).toBe("Hi there");
      expect(typeof apiMessages[1].content).toBe("string");
      expect(apiMessages[2].content).toBe("How are you?");
      expect(typeof apiMessages[2].content).toBe("string");
    });
  });

  it("Anthropic provider handles empty tool input", () => {
    let capturedBody: string | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_empty_1",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "Ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });
    const now = new Date();

    const messages: Message[] = [
      { id: "msg-1", role: "user", content: "List files", createdAt: now },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_ls_1", name: "ls", input: {} },
        ],
        createdAt: now,
      },
      {
        id: "msg-3",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_ls_1", content: "file1.ts\nfile2.ts" },
        ],
        createdAt: now,
      },
    ];

    return provider.chat({ model: "claude-3-5-sonnet-latest", messages }).then(() => {
      const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
      const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

      const toolUseBlocks = apiMessages[1].content as Array<Record<string, unknown>>;
      expect(toolUseBlocks[0].input).toEqual({});
    });
  });

  it("Anthropic provider handles large tool output", () => {
    let capturedBody: string | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_large_1",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "Processed." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 5000, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });
    const now = new Date();
    const largeOutput = "x".repeat(50_000);

    const messages: Message[] = [
      { id: "msg-1", role: "user", content: "Read big file", createdAt: now },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_read_big", name: "read", input: { path: "big.txt" } },
        ],
        createdAt: now,
      },
      {
        id: "msg-3",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_read_big", content: largeOutput },
        ],
        createdAt: now,
      },
    ];

    return provider.chat({ model: "claude-3-5-sonnet-latest", messages }).then(() => {
      const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
      const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

      const resultBlocks = apiMessages[2].content as Array<Record<string, unknown>>;
      expect((resultBlocks[0].content as string).length).toBe(50_000);
    });
  });

  it("resume cycle: save conversation with tool blocks, reload, verify tool context preserved", async () => {
    const store = new InMemoryConversationStore();
    const manager = new ConversationManager(store);

    // Phase 1: Create conversation with tool interactions
    const conversation = await manager.create({
      title: "Tool Resume Test",
      model: "claude-3-5-sonnet-latest",
      provider: "byok-anthropic",
    });

    await manager.addMessage(conversation.id, {
      role: "user",
      content: "Read the config file",
    });

    await manager.addToolUseMessage(conversation.id, [
      { type: "tool_use", id: "toolu_read_1", name: "read", input: { path: "config.ts" } },
    ]);

    await manager.addToolResult(
      conversation.id,
      "toolu_read_1",
      "export default { port: 3000 }",
    );

    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: "The config exports a default object with port 3000.",
    });

    // Phase 2: Simulate restart - create new manager with same store
    const resumedManager = new ConversationManager(store);
    const resumed = await resumedManager.load(conversation.id);

    expect(resumed.messages).toHaveLength(4);

    // Verify tool blocks are preserved
    const assistantToolMsg = resumed.messages[1];
    expect(assistantToolMsg.role).toBe("assistant");
    expect(Array.isArray(assistantToolMsg.content)).toBe(true);
    const toolUseContent = assistantToolMsg.content as ContentBlock[];
    expect(toolUseContent[0].type).toBe("tool_use");
    expect((toolUseContent[0] as ToolUseBlock).name).toBe("read");

    const toolResultMsg = resumed.messages[2];
    expect(toolResultMsg.role).toBe("user");
    expect(Array.isArray(toolResultMsg.content)).toBe(true);
    const toolResultContent = toolResultMsg.content as ContentBlock[];
    expect(toolResultContent[0].type).toBe("tool_result");
    expect((toolResultContent[0] as ToolResultBlock).tool_use_id).toBe("toolu_read_1");

    // Phase 3: Build provider request from resumed history and verify
    let capturedBody: string | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_resumed_1",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "Yes, the config has port 3000." }],
          stop_reason: "end_turn",
          usage: { input_tokens: 150, output_tokens: 15 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });

    // Add a follow-up message to the resumed conversation
    await resumedManager.addMessage(conversation.id, {
      role: "user",
      content: "What port is configured?",
    });

    const fullConversation = await resumedManager.load(conversation.id);

    const response = await provider.chat({
      model: "claude-3-5-sonnet-latest",
      messages: fullConversation.messages,
    });

    expect(response.content).toBe("Yes, the config has port 3000.");

    // Verify the provider payload includes tool blocks from history
    const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
    const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

    expect(apiMessages).toHaveLength(5);

    // Tool use block preserved in API payload
    const toolUseMsg = apiMessages[1].content as Array<Record<string, unknown>>;
    expect(toolUseMsg[0].type).toBe("tool_use");
    expect(toolUseMsg[0].name).toBe("read");

    // Tool result block preserved in API payload
    const toolResultApiMsg = apiMessages[2].content as Array<Record<string, unknown>>;
    expect(toolResultApiMsg[0].type).toBe("tool_result");
    expect(toolResultApiMsg[0].content).toContain("port: 3000");
  });

  it("resume cycle with SQLite: persist and reload tool blocks across store instances", async () => {
    const dbPath = join(tmpdir(), `reins-resume-sqlite-${Date.now()}.db`);

    try {
      // Phase 1: Create and populate with first store instance
      const store1 = new SQLiteConversationStore({ path: dbPath });
      const manager1 = new ConversationManager(store1);

      const conversation = await manager1.create({
        title: "SQLite Resume",
        model: "claude-3-5-sonnet-latest",
        provider: "byok-anthropic",
      });

      await manager1.addMessage(conversation.id, {
        role: "user",
        content: "Edit the file",
      });

      await manager1.addToolUseMessage(conversation.id, [
        { type: "tool_use", id: "toolu_edit_1", name: "edit", input: { path: "app.ts", oldString: "foo", newString: "bar" } },
      ]);

      await manager1.addToolResult(
        conversation.id,
        "toolu_edit_1",
        "Replaced 1 occurrence in app.ts",
      );

      await manager1.addMessage(conversation.id, {
        role: "assistant",
        content: "Done, replaced foo with bar.",
      });

      store1.close();

      // Phase 2: Simulate restart with new store instance
      const store2 = new SQLiteConversationStore({ path: dbPath });
      const manager2 = new ConversationManager(store2);

      const resumed = await manager2.load(conversation.id);
      expect(resumed.messages).toHaveLength(4);

      // Find tool_use and tool_result messages by content type (order may vary with same-ms timestamps)
      const toolUseMsg = resumed.messages.find(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use"),
      );
      expect(toolUseMsg).toBeDefined();
      const blocks = toolUseMsg!.content as ContentBlock[];
      expect(blocks[0].type).toBe("tool_use");
      expect((blocks[0] as ToolUseBlock).id).toBe("toolu_edit_1");
      expect((blocks[0] as ToolUseBlock).input).toEqual({ path: "app.ts", oldString: "foo", newString: "bar" });

      const toolResultMsg = resumed.messages.find(
        (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_result"),
      );
      expect(toolResultMsg).toBeDefined();
      const resultBlocks = toolResultMsg!.content as ContentBlock[];
      expect(resultBlocks[0].type).toBe("tool_result");
      expect((resultBlocks[0] as ToolResultBlock).content).toContain("Replaced 1 occurrence");

      // Phase 3: Build provider request from SQLite-resumed history
      let capturedBody: string | undefined;

      globalThis.fetch = async (_input, init) => {
        capturedBody = init?.body as string;
        return new Response(
          JSON.stringify({
            id: "msg_sqlite_resume",
            model: "claude-3-5-sonnet-latest",
            content: [{ type: "text", text: "The edit was applied." }],
            stop_reason: "end_turn",
            usage: { input_tokens: 100, output_tokens: 10 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };

      const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });

      await manager2.addMessage(conversation.id, {
        role: "user",
        content: "Was the edit successful?",
      });

      const fullConversation = await manager2.load(conversation.id);
      await provider.chat({ model: "claude-3-5-sonnet-latest", messages: fullConversation.messages });

      const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
      const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

      // All 5 messages present including tool blocks
      expect(apiMessages).toHaveLength(5);

      // Find tool_use and tool_result in API payload
      const toolUseApiMsg = apiMessages.find(
        (m) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((b) => b.type === "tool_use"),
      );
      expect(toolUseApiMsg).toBeDefined();
      const toolUseApiBlocks = toolUseApiMsg!.content as Array<Record<string, unknown>>;
      expect(toolUseApiBlocks[0].type).toBe("tool_use");
      expect(toolUseApiBlocks[0].name).toBe("edit");

      const toolResultApiMsg = apiMessages.find(
        (m) => Array.isArray(m.content) && (m.content as Array<Record<string, unknown>>).some((b) => b.type === "tool_result"),
      );
      expect(toolResultApiMsg).toBeDefined();

      store2.close();
    } finally {
      try {
        await rm(dbPath, { force: true });
        await rm(`${dbPath}-wal`, { force: true });
        await rm(`${dbPath}-shm`, { force: true });
      } catch {
        // cleanup best-effort
      }
    }
  });

  it("mixed text and tool blocks in a single assistant message map correctly", () => {
    let capturedBody: string | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_mixed_1",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "Done" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 50, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });
    const now = new Date();

    const messages: Message[] = [
      { id: "msg-1", role: "user", content: "Search and read", createdAt: now },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          { type: "text", text: "Let me search for that." },
          { type: "tool_use", id: "toolu_grep_1", name: "grep", input: { pattern: "TODO", include: "*.ts" } },
          { type: "text", text: "And also read the file." },
          { type: "tool_use", id: "toolu_read_1", name: "read", input: { path: "todo.ts" } },
        ],
        createdAt: now,
      },
    ];

    return provider.chat({ model: "claude-3-5-sonnet-latest", messages }).then(() => {
      const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
      const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

      const blocks = apiMessages[1].content as Array<Record<string, unknown>>;
      expect(blocks).toHaveLength(4);
      expect(blocks[0].type).toBe("text");
      expect(blocks[0].text).toBe("Let me search for that.");
      expect(blocks[1].type).toBe("tool_use");
      expect(blocks[1].name).toBe("grep");
      expect(blocks[2].type).toBe("text");
      expect(blocks[2].text).toBe("And also read the file.");
      expect(blocks[3].type).toBe("tool_use");
      expect(blocks[3].name).toBe("read");
    });
  });

  it("system messages are filtered out from Anthropic provider payload", () => {
    let capturedBody: string | undefined;

    globalThis.fetch = async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(
        JSON.stringify({
          id: "msg_sys_1",
          model: "claude-3-5-sonnet-latest",
          content: [{ type: "text", text: "Ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 20, output_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const provider = new BYOKAnthropicProvider("test-key", { baseUrl: "https://api.anthropic.test" });
    const now = new Date();

    const messages: Message[] = [
      { id: "msg-sys", role: "system", content: "You are a helpful assistant.", createdAt: now },
      { id: "msg-1", role: "user", content: "Hello", createdAt: now },
      {
        id: "msg-2",
        role: "assistant",
        content: [
          { type: "tool_use", id: "toolu_1", name: "read", input: { path: "test.ts" } },
        ],
        createdAt: now,
      },
      {
        id: "msg-3",
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "file contents" },
        ],
        createdAt: now,
      },
    ];

    return provider.chat({ model: "claude-3-5-sonnet-latest", messages }).then(() => {
      const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
      const apiMessages = parsed.messages as Array<{ role: string; content: unknown }>;

      // System message should be filtered out
      expect(apiMessages).toHaveLength(3);
      expect(apiMessages[0].role).toBe("user");
      expect(apiMessages[1].role).toBe("assistant");
      expect(apiMessages[2].role).toBe("user");
    });
  });
});
