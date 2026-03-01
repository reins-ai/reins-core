import { describe, expect, it } from "bun:test";
import { providersHandler } from "../../../../src/channels/commands/handlers/providers";
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

describe("providersHandler", () => {
  it("returns 'No providers registered.' when registry is empty", async () => {
    const result = await providersHandler(makeContext(), []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    expect((result as { text: string }).text).toBe("No providers registered.");
  });

  it("lists providers with connection status", async () => {
    const ctx = makeContext({
      providerRegistry: {
        list: () => [
          { id: "openai", name: "OpenAI", requiresAuth: true, authModes: ["api_key"] },
          { id: "anthropic", name: "Anthropic", requiresAuth: true, authModes: ["oauth"] },
        ],
      },
      providerAuthService: {
        listProviders: async () => [
          {
            provider: "openai",
            configured: true,
            connectionState: "connected",
            authModes: ["api_key"],
          },
          {
            provider: "anthropic",
            configured: false,
            connectionState: "disconnected",
            authModes: ["oauth"],
          },
        ],
        revokeProvider: async () => {},
        setApiKey: async () => {},
        validateConnection: async () => true,
      },
    });

    const result = await providersHandler(ctx, []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    const text = (result as { text: string }).text;
    expect(text).toContain("**Providers**");
    expect(text).toContain("**OpenAI** (openai) — connected | auth: api_key");
    expect(text).toContain("**Anthropic** (anthropic) — not connected | auth: oauth");
  });

  it("shows 'not connected' for all providers when auth service throws", async () => {
    const ctx = makeContext({
      providerRegistry: {
        list: () => [
          { id: "openai", name: "OpenAI", requiresAuth: true, authModes: ["api_key"] },
        ],
      },
      providerAuthService: {
        listProviders: async () => { throw new Error("Auth service down"); },
        revokeProvider: async () => {},
        setApiKey: async () => {},
        validateConnection: async () => true,
      },
    });

    const result = await providersHandler(ctx, []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    const text = (result as { text: string }).text;
    expect(text).toContain("**OpenAI** (openai) — not connected | auth: api_key");
  });

  it("shows multiple providers each on their own line", async () => {
    const ctx = makeContext({
      providerRegistry: {
        list: () => [
          { id: "openai", name: "OpenAI", requiresAuth: true, authModes: ["api_key"] },
          { id: "google", name: "Google", requiresAuth: true, authModes: ["oauth"] },
          { id: "fireworks", name: "Fireworks", requiresAuth: true, authModes: ["api_key"] },
        ],
      },
    });

    const result = await providersHandler(ctx, []);

    const text = (result as { text: string }).text;
    const bulletLines = text.split("\n").filter((l) => l.startsWith("•"));
    expect(bulletLines).toHaveLength(3);
  });

  it("shows auth mode as 'none' when authModes is empty", async () => {
    const ctx = makeContext({
      providerRegistry: {
        list: () => [
          { id: "ollama", name: "Ollama", requiresAuth: false, authModes: [] },
        ],
      },
    });

    const result = await providersHandler(ctx, []);

    const text = (result as { text: string }).text;
    expect(text).toContain("auth: none");
  });
});
