import { describe, expect, it } from "bun:test";
import { clearHandler } from "../../../../src/channels/commands/handlers/clear";
import type { CommandContext } from "../../../../src/channels/commands/types";

function makeContext(
  overrides: Partial<CommandContext> = {},
): CommandContext {
  let model = overrides.currentModel;
  let provider = overrides.currentProvider;
  let conversationId = overrides.conversationId;
  return {
    senderId: "user1",
    channelId: "ch1",
    platform: "telegram",
    currentModel: model,
    currentProvider: provider,
    conversationId,
    conversationManager: {
      create: async () => ({ id: "new-conv-id" }),
      delete: async () => {},
      list: async () => [],
    },
    providerRegistry: {
      list: () => [],
    },
    providerAuthService: {
      listProviders: async () => [],
      revokeProvider: async () => {},
      setApiKey: async () => {},
      validateConnection: async () => true,
    },
    setModel: (m) => { model = m; },
    setProvider: (p) => { provider = p; },
    setConversationId: (id) => { conversationId = id; },
    ...overrides,
  };
}

describe("clearHandler", () => {
  it("returns info message when no active conversation", async () => {
    const ctx = makeContext();
    const result = await clearHandler(ctx, []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    const text = (result as { text: string }).text;
    expect(text).toBe(
      "No active conversation to clear. Use `/new` to start one.",
    );
  });

  it("deletes old conversation and creates new one", async () => {
    let deletedId = "";
    let setId = "";
    const ctx = makeContext({
      conversationId: "old-conv-id",
      conversationManager: {
        create: async () => ({ id: "new-conv-id" }),
        delete: async (id) => { deletedId = id; },
        list: async () => [],
      },
      setConversationId: (id) => { setId = id; },
    });

    const result = await clearHandler(ctx, []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    expect(deletedId).toBe("old-conv-id");
    expect(setId).toBe("new-conv-id");
    const text = (result as { text: string }).text;
    expect(text).toContain("Conversation cleared");
    expect(text).toContain("New ID: `new-conv-id`");
  });

  it("continues to create new conversation when delete throws", async () => {
    let setId = "";
    const ctx = makeContext({
      conversationId: "old-conv-id",
      conversationManager: {
        create: async () => ({ id: "new-conv-id" }),
        delete: async () => { throw new Error("Already deleted"); },
        list: async () => [],
      },
      setConversationId: (id) => { setId = id; },
    });

    const result = await clearHandler(ctx, []);

    expect(result.success).toBe(true);
    expect(setId).toBe("new-conv-id");
    const text = (result as { text: string }).text;
    expect(text).toContain("Conversation cleared");
  });

  it("returns CREATE_FAILED when create throws after delete", async () => {
    const ctx = makeContext({
      conversationId: "old-conv-id",
      conversationManager: {
        create: async () => { throw new Error("DB down"); },
        delete: async () => {},
        list: async () => [],
      },
    });

    const result = await clearHandler(ctx, []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(false);
    expect(result.error).toBe("CREATE_FAILED");
  });
});
