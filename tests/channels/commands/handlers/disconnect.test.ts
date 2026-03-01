import { describe, expect, it } from "bun:test";
import { disconnectHandler } from "../../../../src/channels/commands/handlers/disconnect";
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

describe("disconnectHandler", () => {
  describe("no arguments — show connected providers", () => {
    it("returns text when no providers are connected", async () => {
      const ctx = makeContext({
        providerAuthService: {
          listProviders: async () => [],
          revokeProvider: async () => {},
          setApiKey: async () => {},
          validateConnection: async () => true,
        },
      });

      const result = await disconnectHandler(ctx, []);

      expect(result.kind).toBe("text");
      expect(result.success).toBe(true);
      expect((result as { text: string }).text).toBe(
        "No providers are currently connected.",
      );
    });

    it("returns menu when connected providers exist", async () => {
      const ctx = makeContext({
        providerAuthService: {
          listProviders: async () => [
            {
              provider: "openai",
              configured: true,
              connectionState: "connected",
              authModes: ["api_key"],
            },
          ],
          revokeProvider: async () => {},
          setApiKey: async () => {},
          validateConnection: async () => true,
        },
      });

      const result = await disconnectHandler(ctx, []);

      expect(result.kind).toBe("menu");
      expect(result.success).toBe(true);
      const menu = result as CommandResultMenu;
      expect(menu.items).toHaveLength(1);
      expect(menu.items[0].label).toBe("openai");
    });

    it("treats disconnected providers as not connected", async () => {
      const ctx = makeContext({
        providerAuthService: {
          listProviders: async () => [
            {
              provider: "openai",
              configured: true,
              connectionState: "disconnected",
              authModes: ["api_key"],
            },
          ],
          revokeProvider: async () => {},
          setApiKey: async () => {},
          validateConnection: async () => true,
        },
      });

      const result = await disconnectHandler(ctx, []);

      expect(result.kind).toBe("text");
      expect(result.success).toBe(true);
      expect((result as { text: string }).text).toBe(
        "No providers are currently connected.",
      );
    });

    it("returns LIST_FAILED when listProviders throws", async () => {
      const ctx = makeContext({
        providerAuthService: {
          listProviders: async () => { throw new Error("Service down"); },
          revokeProvider: async () => {},
          setApiKey: async () => {},
          validateConnection: async () => true,
        },
      });

      const result = await disconnectHandler(ctx, []);

      expect(result.success).toBe(false);
      expect(result.error).toBe("LIST_FAILED");
    });
  });

  describe("with arguments — revoke provider", () => {
    it("revokes the named provider and returns success", async () => {
      let revokedProvider = "";
      const ctx = makeContext({
        providerAuthService: {
          listProviders: async () => [],
          revokeProvider: async (p) => { revokedProvider = p; },
          setApiKey: async () => {},
          validateConnection: async () => true,
        },
      });

      const result = await disconnectHandler(ctx, ["openai"]);

      expect(result.kind).toBe("text");
      expect(result.success).toBe(true);
      expect(revokedProvider).toBe("openai");
      const text = (result as { text: string }).text;
      expect(text).toContain("Disconnected **openai**");
    });

    it("returns REVOKE_FAILED when revokeProvider throws", async () => {
      const ctx = makeContext({
        providerAuthService: {
          listProviders: async () => [],
          revokeProvider: async () => { throw new Error("Revoke error"); },
          setApiKey: async () => {},
          validateConnection: async () => true,
        },
      });

      const result = await disconnectHandler(ctx, ["openai"]);

      expect(result.success).toBe(false);
      expect(result.error).toBe("REVOKE_FAILED");
    });

    it("normalizes provider name to lowercase", async () => {
      let revokedProvider = "";
      const ctx = makeContext({
        providerAuthService: {
          listProviders: async () => [],
          revokeProvider: async (p) => { revokedProvider = p; },
          setApiKey: async () => {},
          validateConnection: async () => true,
        },
      });

      await disconnectHandler(ctx, ["OpenAI"]);
      expect(revokedProvider).toBe("openai");
    });
  });
});
