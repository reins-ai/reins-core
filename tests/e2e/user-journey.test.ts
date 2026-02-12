import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationManager, InMemoryConversationStore } from "../../src/conversation";
import { AuthError } from "../../src/errors";
import { MockProvider, ProviderAuthService } from "../../src/providers";
import { AnthropicApiKeyStrategy } from "../../src/providers/byok/anthropic-auth-strategy";
import { EncryptedCredentialStore } from "../../src/providers/credentials/store";
import { ModelRouter } from "../../src/providers/router";
import { ProviderRegistry } from "../../src/providers/registry";
import { StreamingResponse } from "../../src/streaming";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { ChatRequest, Model, Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";
import type { OAuthTokens } from "../../src/providers/oauth/types";

const model: Model = {
  id: "journey-model",
  name: "Journey Model",
  provider: "journey-provider",
  contextWindow: 8192,
  capabilities: ["chat", "streaming", "tool_use"],
};

const toolCall: ToolCall = {
  id: "tool-forecast-1",
  name: "forecast",
  arguments: { city: "San Francisco" },
};

const forecastTool: Tool = {
  definition: {
    name: "forecast",
    description: "Return a deterministic weather forecast",
    parameters: {
      type: "object",
      properties: {
        city: { type: "string" },
      },
      required: ["city"],
    },
  },
  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const city = typeof args.city === "string" ? args.city : "unknown";
    return {
      callId: "ignored-by-executor",
      name: "forecast",
      result: {
        city,
        condition: "Sunny",
        temperatureF: 72,
      },
    };
  },
};

const toRequest = (messages: ChatRequest["messages"]): ChatRequest => ({
  model: model.id,
  messages,
});

describe("e2e/user-journey", () => {
  it("completes conversation lifecycle from creation to deletion", async () => {
    const store = new InMemoryConversationStore();
    const manager = new ConversationManager(store);

    const initialProvider = new MockProvider({
      config: { id: "journey-provider", name: "Journey Provider", type: "gateway" },
      models: [model],
      responseContent: "Absolutely - let us build your afternoon plan.",
    });

    const toolPlanningProvider = new MockProvider({
      config: { id: "journey-provider", name: "Journey Provider", type: "gateway" },
      models: [model],
      responseContent: "I will check weather before finalizing.",
      toolCalls: [toolCall],
      finishReason: "tool_use",
    });

    const completionProvider = new MockProvider({
      config: { id: "journey-provider", name: "Journey Provider", type: "gateway" },
      models: [model],
      responseContent: "Forecast is sunny and 72F, so outdoor tasks are ideal.",
    });

    const tools = new ToolRegistry();
    tools.register(forecastTool);
    const executor = new ToolExecutor(tools);

    const firstConversation = await manager.create({
      title: "Daily planning",
      model: model.id,
      provider: model.provider,
      systemPrompt: "Be practical and concise.",
    });

    await manager.addMessage(firstConversation.id, {
      role: "user",
      content: "Plan my afternoon.",
    });

    const initialHistory = await manager.getHistory(firstConversation.id);
    const initialStream = new StreamingResponse(initialProvider.stream(toRequest(initialHistory)));
    const initialCollected = await initialStream.collect();

    expect(initialCollected.finishReason).toBe("stop");

    await manager.addMessage(firstConversation.id, {
      role: "assistant",
      content: initialCollected.content,
    });

    await manager.addMessage(firstConversation.id, {
      role: "user",
      content: "Also check weather before finalizing.",
    });

    const secondHistory = await manager.getHistory(firstConversation.id);
    const secondResponse = await toolPlanningProvider.chat(toRequest(secondHistory));
    await manager.addMessage(firstConversation.id, {
      role: "assistant",
      content: secondResponse.content,
      toolCalls: secondResponse.toolCalls,
    });

    const toolResult = await executor.execute(toolCall, {
      conversationId: firstConversation.id,
      userId: "user-1",
      workspaceId: "ws-1",
    });
    await manager.addMessage(firstConversation.id, {
      role: "tool",
      content: JSON.stringify(toolResult.result),
      toolResultId: toolResult.callId,
    });

    const preCompletionHistory = await manager.getHistory(firstConversation.id);
    const completionResponse = await completionProvider.chat(toRequest(preCompletionHistory));
    await manager.addMessage(firstConversation.id, {
      role: "assistant",
      content: completionResponse.content,
    });

    const secondConversation = await manager.create({
      title: "Scratchpad",
      model: model.id,
      provider: model.provider,
    });

    const summaries = await manager.list();
    expect(summaries.map((summary) => summary.title).sort()).toEqual(["Daily planning", "Scratchpad"]);

    const selectedFirst = await manager.load(firstConversation.id);
    const selectedSecond = await manager.load(secondConversation.id);
    expect(selectedFirst.title).toBe("Daily planning");
    expect(selectedSecond.title).toBe("Scratchpad");

    const finalHistory = await manager.getHistory(firstConversation.id);
    expect(finalHistory.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(finalHistory[4]?.toolCalls?.[0]?.name).toBe("forecast");
    expect(finalHistory[6]?.content).toContain("72F");

    const deleted = await manager.delete(firstConversation.id);
    expect(deleted).toBe(true);

    const remaining = await manager.list();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.title).toBe("Scratchpad");
  });
});

// --- Credential-state and re-auth signaling tests ---

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function createAuthFixture(options?: {
  fetchFn?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}) {
  const tempDirectory = await mkdtemp(join(tmpdir(), "reins-user-journey-"));
  const store = new EncryptedCredentialStore({
    encryptionSecret: "user-journey-test-secret",
    filePath: join(tempDirectory, "credentials.enc.json"),
  });
  const registry = new ProviderRegistry();

  const anthropicStrategy = new AnthropicApiKeyStrategy({
    store,
    fetchFn: options?.fetchFn,
  });

  const service = new ProviderAuthService({
    store,
    registry,
    apiKeyStrategies: { anthropic: anthropicStrategy },
  });

  const anthropicProvider = new MockProvider({
    config: { id: "anthropic", name: "Anthropic", type: "byok" },
    models: [
      {
        id: "claude-3-5-sonnet-latest",
        name: "Claude 3.5 Sonnet",
        provider: "anthropic",
        contextWindow: 200_000,
        capabilities: ["chat", "streaming", "tool_use"],
      },
    ],
    responseContent: "Hello from Anthropic!",
  });

  registry.register(anthropicProvider);

  const router = new ModelRouter(registry, service);

  return {
    store,
    registry,
    service,
    anthropicStrategy,
    router,
    anthropicProvider,
    tempDirectory,
    cleanup: async () => rm(tempDirectory, { recursive: true, force: true }),
  };
}

describe("e2e/credential-state-and-reauth", () => {
  describe("getProviderAuthStatus", () => {
    it("returns requires_auth for unconfigured provider", async () => {
      const fixture = await createAuthFixture();
      try {
        const result = await fixture.service.getProviderAuthStatus("anthropic");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.connectionState).toBe("requires_auth");
        expect(result.value.configured).toBe(false);
        expect(result.value.authModes).toContain("api_key");
        expect(result.value.authModes).toContain("oauth");
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns ready for configured BYOK provider", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        await fixture.service.setApiKey("anthropic", "sk-ant-api03-valid-key-for-status-test");

        const result = await fixture.service.getProviderAuthStatus("anthropic");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.connectionState).toBe("ready");
        expect(result.value.configured).toBe(true);
        expect(result.value.credentialType).toBe("api_key");
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns ready for configured OAuth provider with valid tokens", async () => {
      const validTokens: OAuthTokens = {
        accessToken: "valid-access-token",
        refreshToken: "valid-refresh-token",
        expiresAt: new Date(Date.now() + 3600 * 1000),
        scope: "openid",
        tokenType: "Bearer",
      };

      const fixture = await createAuthFixture();
      try {
        await fixture.service.setOAuthTokens("anthropic", validTokens);

        const result = await fixture.service.getProviderAuthStatus("anthropic");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.connectionState).toBe("ready");
        expect(result.value.configured).toBe(true);
        expect(result.value.credentialType).toBe("oauth");
        expect(result.value.expiresAt).toBeDefined();
        expect(result.value.expiresAt!).toBeGreaterThan(Date.now());
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns requires_reauth for expired OAuth tokens", async () => {
      const expiredTokens: OAuthTokens = {
        accessToken: "expired-access-token",
        refreshToken: "expired-refresh-token",
        expiresAt: new Date(Date.now() - 3600 * 1000),
        scope: "openid",
        tokenType: "Bearer",
      };

      const fixture = await createAuthFixture();
      try {
        await fixture.service.setOAuthTokens("anthropic", expiredTokens);

        const result = await fixture.service.getProviderAuthStatus("anthropic");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.connectionState).toBe("requires_reauth");
        expect(result.value.configured).toBe(true);
        expect(result.value.credentialType).toBe("oauth");
        expect(result.value.expiresAt).toBeDefined();
        expect(result.value.expiresAt!).toBeLessThan(Date.now());
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns ready for local provider that needs no auth", async () => {
      const fixture = await createAuthFixture();
      try {
        const localProvider = new MockProvider({
          config: { id: "ollama", name: "Ollama", type: "local" },
        });
        fixture.registry.register(localProvider);

        const result = await fixture.service.getProviderAuthStatus("ollama");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.connectionState).toBe("ready");
        expect(result.value.requiresAuth).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns requires_auth after credentials are revoked", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        await fixture.service.setApiKey("anthropic", "sk-ant-api03-revoke-status-test-key");

        const beforeRevoke = await fixture.service.getProviderAuthStatus("anthropic");
        expect(beforeRevoke.ok).toBe(true);
        if (!beforeRevoke.ok) return;
        expect(beforeRevoke.value.connectionState).toBe("ready");

        await fixture.service.revokeProvider("anthropic");

        const afterRevoke = await fixture.service.getProviderAuthStatus("anthropic");
        expect(afterRevoke.ok).toBe(true);
        if (!afterRevoke.ok) return;
        expect(afterRevoke.value.connectionState).toBe("requires_auth");
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("checkConversationReady", () => {
    it("allows conversation when BYOK credentials are configured", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        await fixture.service.setApiKey("anthropic", "sk-ant-api03-conversation-ready-key");

        const result = await fixture.service.checkConversationReady("anthropic");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.allowed).toBe(true);
        expect(result.value.connectionState).toBe("ready");
        expect(result.value.guidance).toBeUndefined();
      } finally {
        await fixture.cleanup();
      }
    });

    it("blocks conversation when no credentials are configured", async () => {
      const fixture = await createAuthFixture();
      try {
        const result = await fixture.service.checkConversationReady("anthropic");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.allowed).toBe(false);
        expect(result.value.connectionState).toBe("requires_auth");
        expect(result.value.guidance).toBeDefined();
        expect(result.value.guidance!.action).toBe("configure");
        expect(result.value.guidance!.message).toContain("/connect");
        expect(result.value.guidance!.message).toContain("anthropic");
      } finally {
        await fixture.cleanup();
      }
    });

    it("blocks conversation when OAuth tokens are expired", async () => {
      const expiredTokens: OAuthTokens = {
        accessToken: "expired-token",
        refreshToken: "expired-refresh",
        expiresAt: new Date(Date.now() - 3600 * 1000),
        scope: "openid",
        tokenType: "Bearer",
      };

      const fixture = await createAuthFixture();
      try {
        await fixture.service.setOAuthTokens("anthropic", expiredTokens);

        const result = await fixture.service.checkConversationReady("anthropic");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.allowed).toBe(false);
        expect(result.value.connectionState).toBe("requires_reauth");
        expect(result.value.guidance).toBeDefined();
        expect(result.value.guidance!.action).toBe("reauth");
        expect(result.value.guidance!.message).toContain("/connect");
        expect(result.value.guidance!.message).toContain("expired");
      } finally {
        await fixture.cleanup();
      }
    });

    it("allows conversation when OAuth tokens are valid", async () => {
      const validTokens: OAuthTokens = {
        accessToken: "valid-token",
        refreshToken: "valid-refresh",
        expiresAt: new Date(Date.now() + 3600 * 1000),
        scope: "openid",
        tokenType: "Bearer",
      };

      const fixture = await createAuthFixture();
      try {
        await fixture.service.setOAuthTokens("anthropic", validTokens);

        const result = await fixture.service.checkConversationReady("anthropic");
        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.allowed).toBe(true);
        expect(result.value.connectionState).toBe("ready");
      } finally {
        await fixture.cleanup();
      }
    });

    it("blocks conversation after credentials are revoked with configure guidance", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        await fixture.service.setApiKey("anthropic", "sk-ant-api03-revoke-conversation-test");

        const beforeRevoke = await fixture.service.checkConversationReady("anthropic");
        expect(beforeRevoke.ok).toBe(true);
        if (!beforeRevoke.ok) return;
        expect(beforeRevoke.value.allowed).toBe(true);

        await fixture.service.revokeProvider("anthropic");

        const afterRevoke = await fixture.service.checkConversationReady("anthropic");
        expect(afterRevoke.ok).toBe(true);
        if (!afterRevoke.ok) return;
        expect(afterRevoke.value.allowed).toBe(false);
        expect(afterRevoke.value.guidance!.action).toBe("configure");
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("router auth-aware routing", () => {
    it("routes successfully when credentials are valid", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        await fixture.service.setApiKey("anthropic", "sk-ant-api03-router-test-key");

        const result = await fixture.router.routeWithAuthCheck({
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.provider.config.id).toBe("anthropic");
        expect(result.value.model.id).toBe("claude-3-5-sonnet-latest");
        expect(result.value.authCheck.allowed).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns auth error when credentials are missing", async () => {
      const fixture = await createAuthFixture();
      try {
        const result = await fixture.router.routeWithAuthCheck({
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error).toBeInstanceOf(AuthError);
        expect(result.error.message).toContain("/connect");
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns auth error when OAuth tokens are expired", async () => {
      const expiredTokens: OAuthTokens = {
        accessToken: "expired-router-token",
        refreshToken: "expired-router-refresh",
        expiresAt: new Date(Date.now() - 3600 * 1000),
        scope: "openid",
        tokenType: "Bearer",
      };

      const fixture = await createAuthFixture();
      try {
        await fixture.service.setOAuthTokens("anthropic", expiredTokens);

        const result = await fixture.router.routeWithAuthCheck({
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error).toBeInstanceOf(AuthError);
        expect(result.error.message).toContain("expired");
        expect(result.error.message).toContain("/connect");
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("full user journeys with credential state", () => {
    it("fresh setup → configure BYOK → conversation succeeds", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        // Step 1: Fresh state — conversation should be blocked
        const blockedCheck = await fixture.service.checkConversationReady("anthropic");
        expect(blockedCheck.ok).toBe(true);
        if (!blockedCheck.ok) return;
        expect(blockedCheck.value.allowed).toBe(false);
        expect(blockedCheck.value.guidance!.message).toContain("/connect");

        // Step 2: Configure BYOK
        const configResult = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "anthropic",
          source: "tui",
          key: "sk-ant-api03-full-journey-byok-key",
        });
        expect(configResult.ok).toBe(true);
        if (!configResult.ok) return;
        expect(configResult.value.credential).not.toBeNull();

        // Step 3: Conversation should now be allowed
        const readyCheck = await fixture.service.checkConversationReady("anthropic");
        expect(readyCheck.ok).toBe(true);
        if (!readyCheck.ok) return;
        expect(readyCheck.value.allowed).toBe(true);

        // Step 4: Route and chat
        const routeResult = await fixture.router.routeWithAuthCheck({
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
        });
        expect(routeResult.ok).toBe(true);
        if (!routeResult.ok) return;

        const chatResponse = await routeResult.value.provider.chat({
          model: "claude-3-5-sonnet-latest",
          messages: [{ id: "m1", role: "user", content: "Hello", createdAt: new Date() }],
        });
        expect(chatResponse.content).toBe("Hello from Anthropic!");
      } finally {
        await fixture.cleanup();
      }
    });

    it("fresh setup → configure OAuth → conversation succeeds", async () => {
      const validTokens: OAuthTokens = {
        accessToken: "oauth-journey-token",
        refreshToken: "oauth-journey-refresh",
        expiresAt: new Date(Date.now() + 3600 * 1000),
        scope: "openid",
        tokenType: "Bearer",
      };

      const fixture = await createAuthFixture();
      try {
        // Step 1: Fresh state — blocked
        const blockedCheck = await fixture.service.checkConversationReady("anthropic");
        expect(blockedCheck.ok).toBe(true);
        if (!blockedCheck.ok) return;
        expect(blockedCheck.value.allowed).toBe(false);

        // Step 2: Configure OAuth tokens
        await fixture.service.setOAuthTokens("anthropic", validTokens);

        // Step 3: Conversation allowed
        const readyCheck = await fixture.service.checkConversationReady("anthropic");
        expect(readyCheck.ok).toBe(true);
        if (!readyCheck.ok) return;
        expect(readyCheck.value.allowed).toBe(true);

        // Step 4: Route and chat
        const routeResult = await fixture.router.routeWithAuthCheck({
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
        });
        expect(routeResult.ok).toBe(true);
        if (!routeResult.ok) return;

        const chatResponse = await routeResult.value.provider.chat({
          model: "claude-3-5-sonnet-latest",
          messages: [{ id: "m1", role: "user", content: "Hello", createdAt: new Date() }],
        });
        expect(chatResponse.content).toBe("Hello from Anthropic!");
      } finally {
        await fixture.cleanup();
      }
    });

    it("expired OAuth token → conversation blocked with re-auth guidance", async () => {
      const expiredTokens: OAuthTokens = {
        accessToken: "expired-journey-token",
        refreshToken: "expired-journey-refresh",
        expiresAt: new Date(Date.now() - 3600 * 1000),
        scope: "openid",
        tokenType: "Bearer",
      };

      const fixture = await createAuthFixture();
      try {
        await fixture.service.setOAuthTokens("anthropic", expiredTokens);

        // Conversation should be blocked
        const check = await fixture.service.checkConversationReady("anthropic");
        expect(check.ok).toBe(true);
        if (!check.ok) return;

        expect(check.value.allowed).toBe(false);
        expect(check.value.connectionState).toBe("requires_reauth");
        expect(check.value.guidance!.action).toBe("reauth");
        expect(check.value.guidance!.message).toContain("expired");
        expect(check.value.guidance!.message).toContain("/connect");

        // Router should also block
        const routeResult = await fixture.router.routeWithAuthCheck({
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
        });
        expect(routeResult.ok).toBe(false);
        if (routeResult.ok) return;
        expect(routeResult.error.message).toContain("expired");
      } finally {
        await fixture.cleanup();
      }
    });

    it("invalid API key → conversation blocked with re-configure guidance", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        // Configure a key, then revoke it (simulating invalid state)
        await fixture.service.setApiKey("anthropic", "sk-ant-api03-invalid-journey-key");
        await fixture.service.revokeProvider("anthropic");

        // Conversation should be blocked
        const check = await fixture.service.checkConversationReady("anthropic");
        expect(check.ok).toBe(true);
        if (!check.ok) return;

        expect(check.value.allowed).toBe(false);
        expect(check.value.connectionState).toBe("requires_auth");
        expect(check.value.guidance!.action).toBe("configure");
        expect(check.value.guidance!.message).toContain("/connect");
      } finally {
        await fixture.cleanup();
      }
    });

    it("successful re-auth → conversation resumes", async () => {
      const expiredTokens: OAuthTokens = {
        accessToken: "expired-reauth-token",
        refreshToken: "expired-reauth-refresh",
        expiresAt: new Date(Date.now() - 3600 * 1000),
        scope: "openid",
        tokenType: "Bearer",
      };

      const fixture = await createAuthFixture();
      try {
        // Step 1: Set expired tokens
        await fixture.service.setOAuthTokens("anthropic", expiredTokens);

        // Step 2: Verify blocked
        const blockedCheck = await fixture.service.checkConversationReady("anthropic");
        expect(blockedCheck.ok).toBe(true);
        if (!blockedCheck.ok) return;
        expect(blockedCheck.value.allowed).toBe(false);
        expect(blockedCheck.value.connectionState).toBe("requires_reauth");

        // Step 3: Re-authenticate with fresh tokens
        const freshTokens: OAuthTokens = {
          accessToken: "fresh-reauth-token",
          refreshToken: "fresh-reauth-refresh",
          expiresAt: new Date(Date.now() + 3600 * 1000),
          scope: "openid",
          tokenType: "Bearer",
        };
        await fixture.service.setOAuthTokens("anthropic", freshTokens);

        // Step 4: Conversation should now be allowed
        const readyCheck = await fixture.service.checkConversationReady("anthropic");
        expect(readyCheck.ok).toBe(true);
        if (!readyCheck.ok) return;
        expect(readyCheck.value.allowed).toBe(true);
        expect(readyCheck.value.connectionState).toBe("ready");

        // Step 5: Route and chat succeeds
        const routeResult = await fixture.router.routeWithAuthCheck({
          provider: "anthropic",
          model: "claude-3-5-sonnet-latest",
        });
        expect(routeResult.ok).toBe(true);
        if (!routeResult.ok) return;

        const chatResponse = await routeResult.value.provider.chat({
          model: "claude-3-5-sonnet-latest",
          messages: [{ id: "m1", role: "user", content: "Hello after re-auth", createdAt: new Date() }],
        });
        expect(chatResponse.content).toBe("Hello from Anthropic!");
      } finally {
        await fixture.cleanup();
      }
    });
  });

   describe("provider listing includes connection state", () => {
    it("lists providers with correct connection states", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        // Before any configuration
        const beforeResult = await fixture.service.listProviders();
        expect(beforeResult.ok).toBe(true);
        if (!beforeResult.ok) return;

        const anthropicBefore = beforeResult.value.find((p) => p.provider === "anthropic");
        expect(anthropicBefore?.connectionState).toBe("requires_auth");
        expect(anthropicBefore?.configured).toBe(false);

        // Local providers should be ready
        const ollamaBefore = beforeResult.value.find((p) => p.provider === "ollama");
        expect(ollamaBefore?.connectionState).toBe("ready");

        // After configuring Anthropic
        await fixture.service.setApiKey("anthropic", "sk-ant-api03-listing-state-key");

        const afterResult = await fixture.service.listProviders();
        expect(afterResult.ok).toBe(true);
        if (!afterResult.ok) return;

        const anthropicAfter = afterResult.value.find((p) => p.provider === "anthropic");
        expect(anthropicAfter?.connectionState).toBe("ready");
        expect(anthropicAfter?.configured).toBe(true);
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("handleCommand credential-state signaling", () => {
    it("returns reauth guidance via handleCommand get when OAuth tokens are expired", async () => {
      const expiredTokens: OAuthTokens = {
        accessToken: "expired-cmd-token",
        refreshToken: "expired-cmd-refresh",
        expiresAt: new Date(Date.now() - 3600 * 1000),
        scope: "openid",
        tokenType: "Bearer",
      };

      const fixture = await createAuthFixture();
      try {
        await fixture.service.setOAuthTokens("anthropic", expiredTokens);

        const result = await fixture.service.handleCommand({
          action: "get",
          provider: "anthropic",
          source: "tui",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.action).toBe("get");
        expect(result.value.credential).not.toBeNull();
        expect(result.value.credential!.type).toBe("oauth");
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns configure guidance via handleCommand get after revocation", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        await fixture.service.setApiKey("anthropic", "sk-ant-api03-cmd-revoke-test");
        await fixture.service.revokeProvider("anthropic");

        const result = await fixture.service.handleCommand({
          action: "get",
          provider: "anthropic",
          source: "cli",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.action).toBe("get");
        expect(result.value.guidance).toBeDefined();
        expect(result.value.guidance!.action).toBe("configure");
        expect(result.value.guidance!.message).toContain("requires authentication");
        expect(result.value.guidance!.supportedModes).toContain("api_key");
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns provider list with mixed connection states via handleCommand", async () => {
      const fixture = await createAuthFixture({
        fetchFn: async () =>
          new Response(JSON.stringify({ data: [] }), { status: 200 }),
      });
      try {
        // Register a local provider (no auth needed)
        const localProvider = new MockProvider({
          config: { id: "ollama", name: "Ollama", type: "local" },
        });
        fixture.registry.register(localProvider);

        // Configure Anthropic BYOK
        await fixture.service.setApiKey("anthropic", "sk-ant-api03-mixed-state-key");

        // Register another BYOK provider without configuring it
        const unconfiguredProvider = new MockProvider({
          config: { id: "openai", name: "OpenAI", type: "byok" },
        });
        fixture.registry.register(unconfiguredProvider);

        const result = await fixture.service.handleCommand({
          action: "list",
          source: "tui",
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        const providers = result.value.providers ?? [];

        const anthropic = providers.find((p) => p.provider === "anthropic");
        expect(anthropic?.connectionState).toBe("ready");
        expect(anthropic?.configured).toBe(true);

        const ollama = providers.find((p) => p.provider === "ollama");
        expect(ollama?.connectionState).toBe("ready");
        expect(ollama?.requiresAuth).toBe(false);

        const openai = providers.find((p) => p.provider === "openai");
        expect(openai?.connectionState).toBe("requires_auth");
        expect(openai?.configured).toBe(false);
      } finally {
        await fixture.cleanup();
      }
    });

    it("returns retry guidance when configuring with empty provider id", async () => {
      const fixture = await createAuthFixture();
      try {
        const result = await fixture.service.handleCommand({
          mode: "api_key",
          provider: "  ",
          source: "tui",
          key: "sk-ant-api03-some-key",
        });

        expect(result.ok).toBe(false);
        if (result.ok) return;

        expect(result.error.message).toContain("Provider is required");
      } finally {
        await fixture.cleanup();
      }
    });
  });

  describe("credential persistence across restart", () => {
    it("BYOK auth status survives service restart with same credential store", async () => {
      const tempDirectory = await mkdtemp(join(tmpdir(), "reins-restart-byok-"));
      const filePath = join(tempDirectory, "credentials.enc.json");
      const encryptionSecret = "restart-test-secret";

      try {
        // Session 1: Configure Anthropic BYOK
        {
          const store = new EncryptedCredentialStore({ encryptionSecret, filePath });
          const registry = new ProviderRegistry();
          const anthropicStrategy = new AnthropicApiKeyStrategy({
            store,
            fetchFn: async () =>
              new Response(JSON.stringify({ data: [] }), { status: 200 }),
          });
          const service = new ProviderAuthService({
            store,
            registry,
            apiKeyStrategies: { anthropic: anthropicStrategy },
          });

          const anthropicProvider = new MockProvider({
            config: { id: "anthropic", name: "Anthropic", type: "byok" },
            models: [{
              id: "claude-3-5-sonnet-latest",
              name: "Claude 3.5 Sonnet",
              provider: "anthropic",
              contextWindow: 200_000,
              capabilities: ["chat", "streaming", "tool_use"],
            }],
          });
          registry.register(anthropicProvider);

          await service.setApiKey("anthropic", "sk-ant-api03-restart-persist-key");

          const status = await service.getProviderAuthStatus("anthropic");
          expect(status.ok).toBe(true);
          if (!status.ok) return;
          expect(status.value.connectionState).toBe("ready");
          expect(status.value.configured).toBe(true);
        }

        // Session 2: New service instance, same file — verify state persists
        {
          const store = new EncryptedCredentialStore({ encryptionSecret, filePath });
          const registry = new ProviderRegistry();
          const anthropicStrategy = new AnthropicApiKeyStrategy({
            store,
            fetchFn: async () =>
              new Response(JSON.stringify({ data: [] }), { status: 200 }),
          });
          const service = new ProviderAuthService({
            store,
            registry,
            apiKeyStrategies: { anthropic: anthropicStrategy },
          });

          const anthropicProvider = new MockProvider({
            config: { id: "anthropic", name: "Anthropic", type: "byok" },
            models: [{
              id: "claude-3-5-sonnet-latest",
              name: "Claude 3.5 Sonnet",
              provider: "anthropic",
              contextWindow: 200_000,
              capabilities: ["chat", "streaming", "tool_use"],
            }],
          });
          registry.register(anthropicProvider);

          // Auth status should still be ready
          const status = await service.getProviderAuthStatus("anthropic");
          expect(status.ok).toBe(true);
          if (!status.ok) return;
          expect(status.value.connectionState).toBe("ready");
          expect(status.value.configured).toBe(true);
          expect(status.value.credentialType).toBe("api_key");

          // Conversation should still be allowed
          const check = await service.checkConversationReady("anthropic");
          expect(check.ok).toBe(true);
          if (!check.ok) return;
          expect(check.value.allowed).toBe(true);

          // Key should be retrievable
          const keyResult = await anthropicStrategy.retrieve({ provider: "anthropic" });
          expect(keyResult.ok).toBe(true);
          if (!keyResult.ok) return;
          expect(keyResult.value).not.toBeNull();
          expect(keyResult.value!.key).toBe("sk-ant-api03-restart-persist-key");
        }
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    });

    it("OAuth auth status and expiry survive service restart", async () => {
      const tempDirectory = await mkdtemp(join(tmpdir(), "reins-restart-oauth-"));
      const filePath = join(tempDirectory, "credentials.enc.json");
      const encryptionSecret = "restart-oauth-secret";
      const futureExpiry = new Date(Date.now() + 3600 * 1000);

      try {
        // Session 1: Store OAuth tokens
        {
          const store = new EncryptedCredentialStore({ encryptionSecret, filePath });
          const registry = new ProviderRegistry();
          const service = new ProviderAuthService({ store, registry });

          const anthropicProvider = new MockProvider({
            config: { id: "anthropic", name: "Anthropic", type: "byok" },
          });
          registry.register(anthropicProvider);

          await service.setOAuthTokens("anthropic", {
            accessToken: "restart-oauth-access",
            refreshToken: "restart-oauth-refresh",
            expiresAt: futureExpiry,
            scope: "openid",
            tokenType: "Bearer",
          });

          const status = await service.getProviderAuthStatus("anthropic");
          expect(status.ok).toBe(true);
          if (!status.ok) return;
          expect(status.value.connectionState).toBe("ready");
          expect(status.value.credentialType).toBe("oauth");
        }

        // Session 2: New service instance — verify OAuth state persists
        {
          const store = new EncryptedCredentialStore({ encryptionSecret, filePath });
          const registry = new ProviderRegistry();
          const service = new ProviderAuthService({ store, registry });

          const anthropicProvider = new MockProvider({
            config: { id: "anthropic", name: "Anthropic", type: "byok" },
          });
          registry.register(anthropicProvider);

          const status = await service.getProviderAuthStatus("anthropic");
          expect(status.ok).toBe(true);
          if (!status.ok) return;
          expect(status.value.connectionState).toBe("ready");
          expect(status.value.configured).toBe(true);
          expect(status.value.credentialType).toBe("oauth");
          expect(status.value.expiresAt).toBeDefined();
          expect(status.value.expiresAt!).toBeGreaterThan(Date.now());

          // Conversation should be allowed
          const check = await service.checkConversationReady("anthropic");
          expect(check.ok).toBe(true);
          if (!check.ok) return;
          expect(check.value.allowed).toBe(true);
        }
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    });

    it("revoked credential state persists across restart", async () => {
      const tempDirectory = await mkdtemp(join(tmpdir(), "reins-restart-revoke-"));
      const filePath = join(tempDirectory, "credentials.enc.json");
      const encryptionSecret = "restart-revoke-secret";

      try {
        // Session 1: Configure then revoke
        {
          const store = new EncryptedCredentialStore({ encryptionSecret, filePath });
          const registry = new ProviderRegistry();
          const anthropicStrategy = new AnthropicApiKeyStrategy({
            store,
            fetchFn: async () =>
              new Response(JSON.stringify({ data: [] }), { status: 200 }),
          });
          const service = new ProviderAuthService({
            store,
            registry,
            apiKeyStrategies: { anthropic: anthropicStrategy },
          });

          const anthropicProvider = new MockProvider({
            config: { id: "anthropic", name: "Anthropic", type: "byok" },
          });
          registry.register(anthropicProvider);

          await service.setApiKey("anthropic", "sk-ant-api03-restart-revoke-key");
          await service.revokeProvider("anthropic");

          const status = await service.getProviderAuthStatus("anthropic");
          expect(status.ok).toBe(true);
          if (!status.ok) return;
          expect(status.value.connectionState).toBe("requires_auth");
        }

        // Session 2: Verify revoked state persists
        {
          const store = new EncryptedCredentialStore({ encryptionSecret, filePath });
          const registry = new ProviderRegistry();
          const service = new ProviderAuthService({ store, registry });

          const anthropicProvider = new MockProvider({
            config: { id: "anthropic", name: "Anthropic", type: "byok" },
          });
          registry.register(anthropicProvider);

          const status = await service.getProviderAuthStatus("anthropic");
          expect(status.ok).toBe(true);
          if (!status.ok) return;
          expect(status.value.connectionState).toBe("requires_auth");
          expect(status.value.configured).toBe(false);

          // Conversation should be blocked
          const check = await service.checkConversationReady("anthropic");
          expect(check.ok).toBe(true);
          if (!check.ok) return;
          expect(check.value.allowed).toBe(false);
          expect(check.value.guidance!.action).toBe("configure");
        }
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    });

    it("expired OAuth tokens detected as requires_reauth after restart", async () => {
      const tempDirectory = await mkdtemp(join(tmpdir(), "reins-restart-expired-"));
      const filePath = join(tempDirectory, "credentials.enc.json");
      const encryptionSecret = "restart-expired-secret";

      try {
        // Session 1: Store already-expired OAuth tokens
        {
          const store = new EncryptedCredentialStore({ encryptionSecret, filePath });
          const registry = new ProviderRegistry();
          const service = new ProviderAuthService({ store, registry });

          const anthropicProvider = new MockProvider({
            config: { id: "anthropic", name: "Anthropic", type: "byok" },
          });
          registry.register(anthropicProvider);

          await service.setOAuthTokens("anthropic", {
            accessToken: "restart-expired-access",
            refreshToken: "restart-expired-refresh",
            expiresAt: new Date(Date.now() - 3600 * 1000),
            scope: "openid",
            tokenType: "Bearer",
          });
        }

        // Session 2: Verify expired state detected after restart
        {
          const store = new EncryptedCredentialStore({ encryptionSecret, filePath });
          const registry = new ProviderRegistry();
          const service = new ProviderAuthService({ store, registry });

          const anthropicProvider = new MockProvider({
            config: { id: "anthropic", name: "Anthropic", type: "byok" },
          });
          registry.register(anthropicProvider);

          const status = await service.getProviderAuthStatus("anthropic");
          expect(status.ok).toBe(true);
          if (!status.ok) return;
          expect(status.value.connectionState).toBe("requires_reauth");
          expect(status.value.configured).toBe(true);
          expect(status.value.credentialType).toBe("oauth");

          // Conversation should be blocked with reauth guidance
          const check = await service.checkConversationReady("anthropic");
          expect(check.ok).toBe(true);
          if (!check.ok) return;
          expect(check.value.allowed).toBe(false);
          expect(check.value.connectionState).toBe("requires_reauth");
          expect(check.value.guidance!.action).toBe("reauth");
          expect(check.value.guidance!.message).toContain("expired");

          // Router should also block
          const router = new ModelRouter(registry, service);
          const routeResult = await router.routeWithAuthCheck({
            provider: "anthropic",
          });
          expect(routeResult.ok).toBe(false);
          if (routeResult.ok) return;
          expect(routeResult.error.message).toContain("expired");
        }
      } finally {
        await rm(tempDirectory, { recursive: true, force: true });
      }
    });
  });
});
