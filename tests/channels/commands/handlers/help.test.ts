import { describe, expect, it } from "bun:test";
import { createHelpHandler } from "../../../../src/channels/commands/handlers/help";
import { ChannelCommandRegistry } from "../../../../src/channels/commands/registry";
import type {
  CommandContext,
  CommandResult,
} from "../../../../src/channels/commands/types";

function makeContext(): CommandContext {
  return {
    senderId: "user1",
    channelId: "ch1",
    platform: "telegram",
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
    setModel: () => {},
    setProvider: () => {},
    setConversationId: () => {},
  };
}

describe("helpHandler", () => {
  it("returns 'No commands registered.' when registry is empty", async () => {
    const registry = new ChannelCommandRegistry();
    const handler = createHelpHandler(registry);
    const result = await handler(makeContext(), []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    expect((result as { text: string }).text).toBe("No commands registered.");
  });

  it("lists registered commands with descriptions", async () => {
    const registry = new ChannelCommandRegistry();
    registry.register({
      name: "status",
      description: "Show current status",
      handler: async (): Promise<CommandResult> => ({
        kind: "text",
        text: "ok",
        success: true,
      }),
    });
    registry.register({
      name: "model",
      description: "Switch model",
      handler: async (): Promise<CommandResult> => ({
        kind: "text",
        text: "ok",
        success: true,
      }),
    });

    const handler = createHelpHandler(registry);
    const result = await handler(makeContext(), []);

    expect(result.kind).toBe("text");
    expect(result.success).toBe(true);
    const text = (result as { text: string }).text;
    expect(text).toContain("**Available Commands**");
    expect(text).toContain("/status — Show current status");
    expect(text).toContain("/model — Switch model");
  });

  it("includes aliases in the listing", async () => {
    const registry = new ChannelCommandRegistry();
    registry.register({
      name: "help",
      description: "Show help",
      handler: async (): Promise<CommandResult> => ({
        kind: "text",
        text: "ok",
        success: true,
      }),
      aliases: ["h", "?"],
    });

    const handler = createHelpHandler(registry);
    const result = await handler(makeContext(), []);

    const text = (result as { text: string }).text;
    expect(text).toContain("(aliases: /h, /?)");
  });

  it("does not show alias text when command has no aliases", async () => {
    const registry = new ChannelCommandRegistry();
    registry.register({
      name: "status",
      description: "Show status",
      handler: async (): Promise<CommandResult> => ({
        kind: "text",
        text: "ok",
        success: true,
      }),
    });

    const handler = createHelpHandler(registry);
    const result = await handler(makeContext(), []);

    const text = (result as { text: string }).text;
    expect(text).not.toContain("aliases:");
    expect(text).toContain("/status — Show status");
  });
});
