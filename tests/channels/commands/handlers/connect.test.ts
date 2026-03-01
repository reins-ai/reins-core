import { describe, expect, it } from "bun:test";
import {
  connectHandler,
  handleConnectCallback,
  handleConnectReply,
  buildConnectPendingState,
} from "../../../../src/channels/commands/handlers/connect";
import { PENDING_COMMAND_TTL_MS } from "../../../../src/channels/commands/types";
import type {
  CommandContext,
  CommandResultMenu,
} from "../../../../src/channels/commands/types";

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

describe("connectHandler", () => {
  describe("no arguments — provider menu", () => {
    it("returns text when no providers require auth", async () => {
      const ctx = makeContext({
        providerRegistry: {
          list: () => [],
        },
      });

      const result = await connectHandler(ctx, []);

      expect(result.kind).toBe("text");
      expect(result.success).toBe(true);
      expect((result as { text: string }).text).toBe(
        "No configurable providers found.",
      );
    });

    it("returns menu with providers and cancel item", async () => {
      const ctx = makeContext({
        providerRegistry: {
          list: () => [
            { id: "openai", name: "OpenAI", requiresAuth: true, authModes: ["api_key"] },
            { id: "anthropic", name: "Anthropic", requiresAuth: true, authModes: ["oauth"] },
          ],
        },
      });

      const result = await connectHandler(ctx, []);

      expect(result.kind).toBe("menu");
      expect(result.success).toBe(true);
      const menu = result as CommandResultMenu;
      expect(menu.text).toBe("Select a provider to connect:");
      // Provider items + Cancel
      expect(menu.items.length).toBeGreaterThanOrEqual(3);
      const cancelItem = menu.items.find((i) => i.id === "connect:cancel");
      expect(cancelItem).toBeDefined();
      expect(cancelItem!.label).toBe("Cancel");
    });

    it("excludes providers that do not require auth", async () => {
      const ctx = makeContext({
        providerRegistry: {
          list: () => [
            { id: "openai", name: "OpenAI", requiresAuth: true, authModes: ["api_key"] },
            { id: "ollama", name: "Ollama", requiresAuth: false, authModes: [] },
          ],
        },
      });

      const result = await connectHandler(ctx, []);

      expect(result.kind).toBe("menu");
      const menu = result as CommandResultMenu;
      const providerIds = menu.items.map((i) => i.id);
      expect(providerIds).toContain("connect:openai");
      expect(providerIds).not.toContain("connect:ollama");
    });
  });

  describe("with arguments — direct provider flow", () => {
    it("starts API key flow for non-OAuth provider", async () => {
      const result = await connectHandler(makeContext(), ["openai"]);

      expect(result.kind).toBe("text");
      expect(result.success).toBe(true);
      const text = (result as { text: string }).text;
      expect(text).toContain("Please reply with your API key");
    });

    it("returns OAuth guidance for anthropic", async () => {
      const result = await connectHandler(makeContext(), ["anthropic"]);

      expect(result.kind).toBe("text");
      expect(result.success).toBe(true);
      const text = (result as { text: string }).text;
      expect(text).toContain("OAuth authentication");
    });

    it("returns OAuth guidance for google", async () => {
      const result = await connectHandler(makeContext(), ["google"]);

      expect(result.kind).toBe("text");
      expect(result.success).toBe(true);
      const text = (result as { text: string }).text;
      expect(text).toContain("OAuth authentication");
    });
  });
});

describe("handleConnectCallback", () => {
  it("returns cancellation message for cancel callback", async () => {
    const state = buildConnectPendingState("awaiting_provider_selection", {});
    const result = await handleConnectCallback(
      "connect:cancel",
      state,
      makeContext(),
    );

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    expect((result as { text: string }).text).toBe("Connection cancelled.");
  });

  it("starts API key flow for openai callback", async () => {
    const state = buildConnectPendingState("awaiting_provider_selection", {});
    const result = await handleConnectCallback(
      "connect:openai",
      state,
      makeContext(),
    );

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    const text = (result as { text: string }).text;
    expect(text).toContain("Please reply with your API key");
  });

  it("returns OAuth guidance for anthropic callback", async () => {
    const state = buildConnectPendingState("awaiting_provider_selection", {});
    const result = await handleConnectCallback(
      "connect:anthropic",
      state,
      makeContext(),
    );

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    const text = (result as { text: string }).text;
    expect(text).toContain("OAuth authentication");
  });

  it("returns SESSION_EXPIRED for expired state", async () => {
    const state = buildConnectPendingState("awaiting_provider_selection", {});
    state.createdAt = Date.now() - (PENDING_COMMAND_TTL_MS + 1000);

    const result = await handleConnectCallback(
      "connect:openai",
      state,
      makeContext(),
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("SESSION_EXPIRED");
  });
});

describe("handleConnectReply", () => {
  it("returns SESSION_EXPIRED for expired state", async () => {
    const state = buildConnectPendingState("awaiting_api_key", {
      selectedProvider: "openai",
    });
    state.createdAt = Date.now() - (PENDING_COMMAND_TTL_MS + 1000);

    const result = await handleConnectReply("sk-abc123", state, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toBe("SESSION_EXPIRED");
  });

  it("returns INVALID_STATE when no provider in state data", async () => {
    const state = buildConnectPendingState("awaiting_api_key", {});

    const result = await handleConnectReply("sk-abc123", state, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toBe("INVALID_STATE");
  });

  it("returns EMPTY_KEY with deleteUserMessage flag for empty key", async () => {
    const state = buildConnectPendingState("awaiting_api_key", {
      selectedProvider: "openai",
    });

    const result = await handleConnectReply("  ", state, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toBe("EMPTY_KEY");
    expect(result.flags).toContain("deleteUserMessage");
  });

  it("returns STORE_FAILED with deleteUserMessage when setApiKey throws", async () => {
    const ctx = makeContext({
      providerAuthService: {
        listProviders: async () => [],
        revokeProvider: async () => {},
        setApiKey: async () => { throw new Error("Storage error"); },
        validateConnection: async () => true,
      },
    });
    const state = buildConnectPendingState("awaiting_api_key", {
      selectedProvider: "openai",
    });

    const result = await handleConnectReply("sk-abc123", state, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toBe("STORE_FAILED");
    expect(result.flags).toContain("deleteUserMessage");
  });

  it("returns success with 'Connection validated' when validateConnection returns true", async () => {
    const ctx = makeContext({
      providerAuthService: {
        listProviders: async () => [],
        revokeProvider: async () => {},
        setApiKey: async () => {},
        validateConnection: async () => true,
      },
    });
    const state = buildConnectPendingState("awaiting_api_key", {
      selectedProvider: "openai",
    });

    const result = await handleConnectReply("sk-abc123", state, ctx);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    expect(result.flags).toContain("deleteUserMessage");
    const text = (result as { text: string }).text;
    expect(text).toContain("Connection validated");
  });

  it("returns success with 'Key stored' when validateConnection returns false", async () => {
    const ctx = makeContext({
      providerAuthService: {
        listProviders: async () => [],
        revokeProvider: async () => {},
        setApiKey: async () => {},
        validateConnection: async () => false,
      },
    });
    const state = buildConnectPendingState("awaiting_api_key", {
      selectedProvider: "openai",
    });

    const result = await handleConnectReply("sk-abc123", state, ctx);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    expect(result.flags).toContain("deleteUserMessage");
    const text = (result as { text: string }).text;
    expect(text).toContain("Key stored");
  });
});

describe("buildConnectPendingState", () => {
  it("creates state with correct command and step", () => {
    const state = buildConnectPendingState("awaiting_provider_selection", {});
    expect(state.command).toBe("connect");
    expect(state.step).toBe("awaiting_provider_selection");
    expect(state.createdAt).toBeGreaterThan(0);
  });

  it("includes provided data", () => {
    const state = buildConnectPendingState("awaiting_api_key", {
      selectedProvider: "openai",
    });
    expect(state.data.selectedProvider).toBe("openai");
  });
});
