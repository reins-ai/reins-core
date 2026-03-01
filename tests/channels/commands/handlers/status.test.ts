import { describe, expect, it } from "bun:test";
import { statusHandler } from "../../../../src/channels/commands/handlers/status";
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
      create: async () => ({ id: "conv-id" }),
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

describe("statusHandler", () => {
  it("returns text result with success true", async () => {
    const result = await statusHandler(makeContext(), []);
    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
  });

  it("starts with **Reins Status** header", async () => {
    const result = await statusHandler(makeContext(), []);
    const text = (result as { text: string }).text;
    expect(text).toStartWith("**Reins Status**");
  });

  it("uses senderName when available", async () => {
    const ctx = makeContext({ senderName: "Alice" });
    const result = await statusHandler(ctx, []);
    const text = (result as { text: string }).text;
    expect(text).toContain("User: Alice");
  });

  it("falls back to senderId when senderName is absent", async () => {
    const ctx = makeContext({ senderId: "user42" });
    const result = await statusHandler(ctx, []);
    const text = (result as { text: string }).text;
    expect(text).toContain("User: user42");
  });

  it("shows 'not set' when model is undefined", async () => {
    const result = await statusHandler(makeContext(), []);
    const text = (result as { text: string }).text;
    expect(text).toContain("Model: not set");
  });

  it("shows current model when set", async () => {
    const ctx = makeContext({ currentModel: "claude-3-5-sonnet" });
    const result = await statusHandler(ctx, []);
    const text = (result as { text: string }).text;
    expect(text).toContain("Model: claude-3-5-sonnet");
  });

  it("shows 'not set' when provider is undefined", async () => {
    const result = await statusHandler(makeContext(), []);
    const text = (result as { text: string }).text;
    expect(text).toContain("Provider: not set");
  });

  it("shows current provider when set", async () => {
    const ctx = makeContext({ currentProvider: "anthropic" });
    const result = await statusHandler(ctx, []);
    const text = (result as { text: string }).text;
    expect(text).toContain("Provider: anthropic");
  });

  it("shows 'none (no active conversation)' when conversationId is undefined", async () => {
    const result = await statusHandler(makeContext(), []);
    const text = (result as { text: string }).text;
    expect(text).toContain("Conversation: none (no active conversation)");
  });

  it("shows conversation ID when set", async () => {
    const ctx = makeContext({ conversationId: "conv-abc-123" });
    const result = await statusHandler(ctx, []);
    const text = (result as { text: string }).text;
    expect(text).toContain("Conversation: conv-abc-123");
  });

  it("shows platform", async () => {
    const ctx = makeContext({ platform: "discord" });
    const result = await statusHandler(ctx, []);
    const text = (result as { text: string }).text;
    expect(text).toContain("Platform: discord");
  });
});
