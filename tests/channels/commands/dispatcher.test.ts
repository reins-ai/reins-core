import { describe, expect, it } from "bun:test";
import { CommandDispatcher } from "../../../src/channels/commands/dispatcher";
import { ChannelCommandRegistry } from "../../../src/channels/commands/registry";
import { ChannelAuthService } from "../../../src/channels/auth-service";
import { InMemoryChannelAuthStorage } from "../../../src/channels/memory-auth-storage";
import type { PendingCommandState } from "../../../src/channels/commands/types";
import { PENDING_COMMAND_TTL_MS } from "../../../src/channels/commands/types";
import type { ChannelMessage, Channel } from "../../../src/channels/types";

function makeAuthService(
  initial?: Record<string, string[]>,
): ChannelAuthService {
  return new ChannelAuthService(new InMemoryChannelAuthStorage(initial));
}

function makeMessage(text: string, senderId = "user1"): ChannelMessage {
  return {
    id: "msg-1",
    platform: "telegram",
    channelId: "ch1",
    text,
    sender: { id: senderId, username: "testuser" },
    timestamp: new Date(),
  };
}

function makeChannel(channelId = "ch1"): Channel {
  return {
    config: {
      id: channelId,
      platform: "telegram",
      tokenReference: "test-token",
      enabled: true,
    },
    status: { state: "connected", uptimeMs: 0 },
    connect: async () => {},
    disconnect: async () => {},
    send: async () => {},
    onMessage: () => () => {},
  } as Channel;
}

const mockConversationManager = {
  create: async () => ({ id: "conv-new" }),
  delete: async () => {},
  list: async () => [],
};

const mockProviderRegistry = {
  list: () => [],
};

const mockProviderAuthService = {
  listProviders: async () => [],
  revokeProvider: async () => {},
  setApiKey: async () => {},
  validateConnection: async () => true,
};

function makeDispatcher(
  authService: ChannelAuthService,
  setupRegistry?: (r: ChannelCommandRegistry) => void,
): CommandDispatcher {
  const registry = new ChannelCommandRegistry();
  registry.register({
    name: "status",
    description: "Show status",
    handler: async () => ({ kind: "text" as const, text: "Status OK", success: true }),
  });
  registry.register({
    name: "connect",
    description: "Connect provider",
    handler: async () => ({
      kind: "menu" as const,
      text: "Select provider:",
      items: [{ id: "connect:openai", label: "OpenAI" }],
      success: true,
    }),
  });
  setupRegistry?.(registry);
  return new CommandDispatcher({
    registry,
    authService,
    conversationManager: mockConversationManager,
    providerRegistry: mockProviderRegistry,
    providerAuthService: mockProviderAuthService,
  });
}

describe("CommandDispatcher", () => {
  describe("isCommandMessage", () => {
    it("returns true for a registered slash command", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("/status");
      expect(dispatcher.isCommandMessage(msg, "user1")).toBe(true);
    });

    it("returns false for an unregistered slash command", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("/unknown");
      expect(dispatcher.isCommandMessage(msg, "user1")).toBe(false);
    });

    it("returns false for plain text without pending state", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("hello world");
      expect(dispatcher.isCommandMessage(msg, "user1")).toBe(false);
    });

    it("returns false for slash alone", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("/");
      expect(dispatcher.isCommandMessage(msg, "user1")).toBe(false);
    });

    it("returns true for plain text when user has awaiting_api_key pending state", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      dispatcher.setPendingState("user1", {
        command: "connect",
        step: "awaiting_api_key",
        data: { selectedProvider: "openai" },
        createdAt: Date.now(),
      });
      const msg = makeMessage("sk-my-api-key");
      expect(dispatcher.isCommandMessage(msg, "user1")).toBe(true);
    });

    it("returns false for plain text when user has awaiting_provider_selection pending state", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      dispatcher.setPendingState("user1", {
        command: "connect",
        step: "awaiting_provider_selection",
        data: {},
        createdAt: Date.now(),
      });
      const msg = makeMessage("some text");
      expect(dispatcher.isCommandMessage(msg, "user1")).toBe(false);
    });
  });

  describe("dispatch — authorization", () => {
    it("returns rejection result for unauthorized sender", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("/status", "intruder");
      const result = await dispatcher.dispatch(msg, makeChannel(), "intruder");
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      if (result!.kind === "text") {
        expect(result!.error).toBe("UNAUTHORIZED");
      }
    });

    it("returns handler result for authorized sender", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("/status");
      const result = await dispatcher.dispatch(msg, makeChannel(), "user1");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("text");
      expect(result!.success).toBe(true);
    });
  });

  describe("dispatch — normal commands", () => {
    it("dispatches /status and returns handler result", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("/status");
      const result = await dispatcher.dispatch(msg, makeChannel(), "user1");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("text");
      if (result!.kind === "text") {
        expect(result!.text).toBe("Status OK");
      }
      expect(result!.success).toBe(true);
    });

    it("returns null for unregistered command", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("/foo");
      const result = await dispatcher.dispatch(msg, makeChannel(), "user1");
      expect(result).toBeNull();
    });

    it("returns null for non-slash text with no pending state", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("hello world");
      const result = await dispatcher.dispatch(msg, makeChannel(), "user1");
      expect(result).toBeNull();
    });
  });

  describe("dispatch — pending state for /connect", () => {
    it("sets awaiting_provider_selection pending state after /connect", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("/connect");
      await dispatcher.dispatch(msg, makeChannel(), "user1");
      const pending = dispatcher.getPendingState("user1");
      expect(pending).toBeDefined();
      expect(pending!.step).toBe("awaiting_provider_selection");
      expect(pending!.command).toBe("connect");
    });

    it("clears pending state and invokes handleConnectReply for plain text with awaiting_api_key", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      dispatcher.setPendingState("user1", {
        command: "connect",
        step: "awaiting_api_key",
        data: { selectedProvider: "openai" },
        createdAt: Date.now(),
      });
      const msg = makeMessage("sk-test-key-12345");
      const result = await dispatcher.dispatch(msg, makeChannel(), "user1");
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("text");
      expect(result!.success).toBe(true);
      expect(dispatcher.getPendingState("user1")).toBeUndefined();
    });
  });

  describe("dispatchCallback — connect", () => {
    it("returns cancellation result and clears pending state for connect:cancel", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      dispatcher.setPendingState("user1", {
        command: "connect",
        step: "awaiting_provider_selection",
        data: {},
        createdAt: Date.now(),
      });
      const msg = makeMessage("", "user1");
      const result = await dispatcher.dispatchCallback(
        "connect:cancel",
        msg,
        makeChannel(),
        "user1",
      );
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("text");
      if (result!.kind === "text") {
        expect(result!.text).toBe("Connection cancelled.");
      }
      expect(result!.success).toBe(true);
      expect(dispatcher.getPendingState("user1")).toBeUndefined();
    });

    it("returns session-expired result when no pending state exists", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const msg = makeMessage("", "user1");
      const result = await dispatcher.dispatchCallback(
        "connect:openai",
        msg,
        makeChannel(),
        "user1",
      );
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("text");
      if (result!.kind === "text") {
        expect(result!.error).toBe("SESSION_EXPIRED");
      }
      expect(result!.success).toBe(false);
    });

    it("sets awaiting_api_key state after connect:openai callback", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      dispatcher.setPendingState("user1", {
        command: "connect",
        step: "awaiting_provider_selection",
        data: {},
        createdAt: Date.now(),
      });
      const msg = makeMessage("", "user1");
      const result = await dispatcher.dispatchCallback(
        "connect:openai",
        msg,
        makeChannel(),
        "user1",
      );
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      const pending = dispatcher.getPendingState("user1");
      expect(pending).toBeDefined();
      expect(pending!.step).toBe("awaiting_api_key");
      expect(pending!.data.selectedProvider).toBe("openai");
    });

    it("sets awaiting_api_key for anthropic when getOAuthAuthorizationUrl is not available", async () => {
      // Without getOAuthAuthorizationUrl on the service, anthropic falls through to API key flow.
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      dispatcher.setPendingState("user1", {
        command: "connect",
        step: "awaiting_provider_selection",
        data: {},
        createdAt: Date.now(),
      });
      const msg = makeMessage("", "user1");
      const result = await dispatcher.dispatchCallback(
        "connect:anthropic",
        msg,
        makeChannel(),
        "user1",
      );
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      const pending = dispatcher.getPendingState("user1");
      expect(pending).toBeDefined();
      expect(pending!.step).toBe("awaiting_api_key");
      expect(pending!.data.selectedProvider).toBe("anthropic");
    });

    it("sets awaiting_auth_code when getOAuthAuthorizationUrl returns a URL", async () => {
      const authServiceWithOAuth = makeAuthService({ ch1: ["user1"] });
      const dispatcher = makeDispatcher(authServiceWithOAuth, (registry) => {
        // Override connect handler to use a service that supports OAuth URL generation.
        // The real connect handler is loaded dynamically; we simulate it returning oauthPending
        // by registering a handler that yields the expected text+oauthPending result directly.
        registry.register({
          name: "connect-oauth-test",
          description: "OAuth test",
          handler: async () => ({
            kind: "text" as const,
            text: "Tap the link: https://example.com/authorize",
            success: true,
            oauthPending: {
              provider: "anthropic",
              state: "state-123",
              codeVerifier: "cv-abc",
            },
          }),
        });
      });

      // Manually test the pending state logic: after a callback yields oauthPending,
      // the dispatcher should store awaiting_auth_code state.
      // We simulate this by calling setPendingState and checking the dispatch path.
      // Since dispatchCallback calls handleConnectCallback (which calls startProviderFlow),
      // we test via a direct connect callback with a dispatcher that has getOAuthAuthorizationUrl.

      // Build a dispatcher with a mocked providerAuthService that has getOAuthAuthorizationUrl.
      const registry2 = new ChannelCommandRegistry();
      const { ChannelCommandRegistry: CmdRegistry } = await import("../../../src/channels/commands/registry");
      const { connectHandler } = await import("../../../src/channels/commands/handlers/connect");
      const reg2 = new CmdRegistry();
      reg2.register({ name: "connect", description: "Connect", handler: connectHandler });

      const { CommandDispatcher: CmdDispatcher } = await import("../../../src/channels/commands/dispatcher");
      const dispatcher2 = new CmdDispatcher({
        registry: reg2,
        authService: authServiceWithOAuth,
        conversationManager: mockConversationManager,
        providerRegistry: mockProviderRegistry,
        providerAuthService: {
          ...mockProviderAuthService,
          getOAuthAuthorizationUrl: async () => ({
            url: "https://example.com/oauth/authorize?state=xyz",
            state: "xyz",
            codeVerifier: "cv-123",
          }),
        },
      });
      dispatcher2.setPendingState("user1", {
        command: "connect",
        step: "awaiting_provider_selection",
        data: {},
        createdAt: Date.now(),
      });

      const msg = makeMessage("", "user1");
      const result = await dispatcher2.dispatchCallback(
        "connect:anthropic",
        msg,
        makeChannel(),
        "user1",
      );
      expect(result).not.toBeNull();
      expect(result!.success).toBe(true);
      const pending = dispatcher2.getPendingState("user1");
      expect(pending).toBeDefined();
      expect(pending!.step).toBe("awaiting_auth_code");
      expect(pending!.data.selectedProvider).toBe("anthropic");
      expect(pending!.data.oauthState).toBe("xyz");
      expect(pending!.data.oauthCodeVerifier).toBe("cv-123");
    });
  });

  describe("dispatchCallback — authorization", () => {
    it("returns UNAUTHORIZED result for unauthorized user callback", async () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      dispatcher.setPendingState("intruder", {
        command: "connect",
        step: "awaiting_provider_selection",
        data: {},
        createdAt: Date.now(),
      });
      const msg = makeMessage("", "intruder");
      const result = await dispatcher.dispatchCallback(
        "connect:openai",
        msg,
        makeChannel(),
        "intruder",
      );
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
      if (result!.kind === "text") {
        expect(result!.error).toBe("UNAUTHORIZED");
      }
    });
  });

  describe("dispatchCallback — disconnect", () => {
    it("calls revokeProvider and returns disconnect result", async () => {
      let revokedProvider: string | undefined;
      const authService = makeAuthService({ ch1: ["user1"] });
      const registry = new ChannelCommandRegistry();
      registry.register({
        name: "status",
        description: "Show status",
        handler: async () => ({ kind: "text" as const, text: "ok", success: true }),
      });
      const dispatcher = new CommandDispatcher({
        registry,
        authService,
        conversationManager: mockConversationManager,
        providerRegistry: mockProviderRegistry,
        providerAuthService: {
          ...mockProviderAuthService,
          revokeProvider: async (provider: string) => {
            revokedProvider = provider;
          },
        },
      });
      const msg = makeMessage("", "user1");
      const result = await dispatcher.dispatchCallback(
        "disconnect:openai",
        msg,
        makeChannel(),
        "user1",
      );
      expect(result).not.toBeNull();
      expect(result!.kind).toBe("text");
      expect(result!.success).toBe(true);
      if (result!.kind === "text") {
        expect(result!.text).toContain("openai");
      }
      expect(revokedProvider).toBe("openai");
    });
  });

  describe("pending state TTL", () => {
    it("returns state when accessed immediately after setting", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const state: PendingCommandState = {
        command: "connect",
        step: "awaiting_provider_selection",
        data: {},
        createdAt: Date.now(),
      };
      dispatcher.setPendingState("user1", state);
      expect(dispatcher.getPendingState("user1")).toBeDefined();
      expect(dispatcher.getPendingState("user1")!.step).toBe("awaiting_provider_selection");
    });

    it("returns undefined for expired pending state", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      const expiredState: PendingCommandState = {
        command: "connect",
        step: "awaiting_api_key",
        data: { selectedProvider: "openai" },
        createdAt: Date.now() - (PENDING_COMMAND_TTL_MS + 60_000),
      };
      dispatcher.setPendingState("user1", expiredState);
      expect(dispatcher.getPendingState("user1")).toBeUndefined();
    });

    it("returns undefined when no pending state exists", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      expect(dispatcher.getPendingState("user1")).toBeUndefined();
    });

    it("replaces existing pending state for the same userId", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      dispatcher.setPendingState("user1", {
        command: "connect",
        step: "awaiting_provider_selection",
        data: {},
        createdAt: Date.now(),
      });
      dispatcher.setPendingState("user1", {
        command: "connect",
        step: "awaiting_api_key",
        data: { selectedProvider: "openai" },
        createdAt: Date.now(),
      });
      const pending = dispatcher.getPendingState("user1");
      expect(pending).toBeDefined();
      expect(pending!.step).toBe("awaiting_api_key");
      expect(pending!.data.selectedProvider).toBe("openai");
    });

    it("clears pending state via clearPendingState", () => {
      const dispatcher = makeDispatcher(makeAuthService({ ch1: ["user1"] }));
      dispatcher.setPendingState("user1", {
        command: "connect",
        step: "awaiting_api_key",
        data: { selectedProvider: "openai" },
        createdAt: Date.now(),
      });
      dispatcher.clearPendingState("user1");
      expect(dispatcher.getPendingState("user1")).toBeUndefined();
    });
  });
});
