import { describe, expect, it } from "bun:test";
import { modelHandler } from "../../../../src/channels/commands/handlers/model";
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

describe("modelHandler", () => {
  describe("no arguments — show current model", () => {
    it("shows current model and provider", async () => {
      const ctx = makeContext({
        currentModel: "claude-3-5-sonnet",
        currentProvider: "anthropic",
      });
      const result = await modelHandler(ctx, []);

      expect(result.kind).toBe("text");
      expect(result.success).toBe(true);
      const text = (result as { text: string }).text;
      expect(text).toContain("Current model: **claude-3-5-sonnet**");
      expect(text).toContain("(provider: anthropic)");
    });

    it("shows 'not set' when model and provider are undefined", async () => {
      const result = await modelHandler(makeContext(), []);
      const text = (result as { text: string }).text;
      expect(text).toContain("Current model: **not set**");
      expect(text).toContain("(provider: not set)");
    });
  });

  describe("with arguments — switch model", () => {
    it("switches to claude model and infers anthropic provider", async () => {
      let setModelCalled = "";
      let setProviderCalled = "";
      const ctx = makeContext({
        setModel: (m) => { setModelCalled = m; },
        setProvider: (p) => { setProviderCalled = p; },
      });

      const result = await modelHandler(ctx, ["claude-3-5-sonnet"]);

      expect(result.kind).toBe("text");
      expect(result.success).toBe(true);
      expect(setModelCalled).toBe("claude-3-5-sonnet");
      expect(setProviderCalled).toBe("anthropic");
      const text = (result as { text: string }).text;
      expect(text).toContain("Switched to model **claude-3-5-sonnet**");
      expect(text).toContain("(provider: anthropic)");
    });

    it("switches to gpt model and infers openai provider", async () => {
      let setProviderCalled = "";
      const ctx = makeContext({
        setProvider: (p) => { setProviderCalled = p; },
      });

      const result = await modelHandler(ctx, ["gpt-4o"]);

      expect(result.success).toBe(true);
      expect(setProviderCalled).toBe("openai");
      const text = (result as { text: string }).text;
      expect(text).toContain("(provider: openai)");
    });

    it("switches to gemini model and infers google provider", async () => {
      let setProviderCalled = "";
      const ctx = makeContext({
        setProvider: (p) => { setProviderCalled = p; },
      });

      const result = await modelHandler(ctx, ["gemini-pro"]);

      expect(result.success).toBe(true);
      expect(setProviderCalled).toBe("google");
      const text = (result as { text: string }).text;
      expect(text).toContain("(provider: google)");
    });

    it("switches to llama model and infers fireworks provider", async () => {
      let setProviderCalled = "";
      const ctx = makeContext({
        setProvider: (p) => { setProviderCalled = p; },
      });

      const result = await modelHandler(ctx, ["llama-3"]);

      expect(result.success).toBe(true);
      expect(setProviderCalled).toBe("fireworks");
      const text = (result as { text: string }).text;
      expect(text).toContain("(provider: fireworks)");
    });

    it("does not infer provider for unknown model prefix", async () => {
      let setProviderCalled = false;
      const ctx = makeContext({
        setProvider: () => { setProviderCalled = true; },
      });

      const result = await modelHandler(ctx, ["unknown-model"]);

      expect(result.success).toBe(true);
      expect(setProviderCalled).toBe(false);
      const text = (result as { text: string }).text;
      expect(text).toContain("Switched to model **unknown-model**");
      expect(text).not.toContain("(provider:");
    });

    it("calls setModel with the provided model name", async () => {
      let setModelCalled = "";
      const ctx = makeContext({
        setModel: (m) => { setModelCalled = m; },
      });

      await modelHandler(ctx, ["my-custom-model"]);
      expect(setModelCalled).toBe("my-custom-model");
    });
  });
});
