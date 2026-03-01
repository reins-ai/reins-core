import { describe, expect, it } from "bun:test";
import { newHandler } from "../../../../src/channels/commands/handlers/new";
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

describe("newHandler", () => {
  it("creates a conversation with default title when no args", async () => {
    let createOpts: { title?: string } = {};
    const ctx = makeContext({
      conversationManager: {
        create: async (opts) => {
          createOpts = opts;
          return { id: "new-conv-id" };
        },
        delete: async () => {},
        list: async () => [],
      },
    });

    const result = await newHandler(ctx, []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    expect(createOpts.title).toBe("New conversation");
    const text = (result as { text: string }).text;
    expect(text).toContain("ID: `new-conv-id`");
  });

  it("creates a conversation with custom title from args", async () => {
    let createOpts: { title?: string } = {};
    const ctx = makeContext({
      conversationManager: {
        create: async (opts) => {
          createOpts = opts;
          return { id: "new-conv-id" };
        },
        delete: async () => {},
        list: async () => [],
      },
    });

    const result = await newHandler(ctx, ["My", "Chat"]);

    expect(result.success).toBe(true);
    expect(createOpts.title).toBe("My Chat");
    const text = (result as { text: string }).text;
    expect(text).toContain(`"My Chat"`);
  });

  it("calls setConversationId with the new conversation ID", async () => {
    let setId = "";
    const ctx = makeContext({
      setConversationId: (id) => { setId = id; },
    });

    await newHandler(ctx, []);
    expect(setId).toBe("new-conv-id");
  });

  it("includes the new conversation ID in the response text", async () => {
    const result = await newHandler(makeContext(), []);
    const text = (result as { text: string }).text;
    expect(text).toContain("ID: `new-conv-id`");
  });

  it("returns CREATE_FAILED error when create throws", async () => {
    const ctx = makeContext({
      conversationManager: {
        create: async () => { throw new Error("DB down"); },
        delete: async () => {},
        list: async () => [],
      },
    });

    const result = await newHandler(ctx, []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(false);
    expect(result.error).toBe("CREATE_FAILED");
  });
});
