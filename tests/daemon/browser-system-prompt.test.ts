import { describe, expect, it } from "bun:test";

import { ok } from "../../src/result";
import { BROWSER_SYSTEM_PROMPT } from "../../src/browser/system-prompt";
import { DaemonHttpServer } from "../../src/daemon/server";
import type { BrowserDaemonService } from "../../src/browser/browser-daemon-service";
import type { ConversationManager } from "../../src/conversation/manager";
import type { ProviderAuthService } from "../../src/providers/auth-service";
import type { ModelRouter } from "../../src/providers/router";
import type { ChatRequest, Model, Provider, StreamEvent } from "../../src/types";

function createProviderStub(): Provider {
  return {
    config: {
      id: "anthropic",
      name: "Anthropic",
      type: "oauth",
    },
    async chat(): Promise<never> {
      throw new Error("chat() is not used in browser system prompt wiring test");
    },
    async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
      yield { type: "done", finishReason: "stop" };
    },
    async listModels(): Promise<Model[]> {
      return [
        {
          id: "claude-test",
          name: "Claude Test",
          provider: "anthropic",
          capabilities: ["chat", "streaming"],
          contextWindow: 8_192,
        },
      ];
    },
    async validateConnection(): Promise<boolean> {
      return true;
    },
  };
}

function createConversationManagerStub(baseSystemPrompt: string): ConversationManager {
  return {
    load: async () => ({
      id: "conv-1",
      provider: "anthropic",
      model: "claude-test",
      personaId: "persona-default",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "hello",
          createdAt: new Date("2026-02-20T10:00:00.000Z"),
          updatedAt: new Date("2026-02-20T10:00:00.000Z"),
        },
        {
          id: "assistant-1",
          role: "assistant",
          content: "",
          createdAt: new Date("2026-02-20T10:00:01.000Z"),
          updatedAt: new Date("2026-02-20T10:00:01.000Z"),
        },
      ],
      createdAt: new Date("2026-02-20T10:00:00.000Z"),
      updatedAt: new Date("2026-02-20T10:00:01.000Z"),
    }),
    getEnvironmentSystemPrompt: async () => baseSystemPrompt,
    completeAssistantMessage: async () => undefined,
  } as unknown as ConversationManager;
}

function createAuthServiceStub(): ProviderAuthService {
  return {
    checkConversationReady: async () => ok({ allowed: true, provider: "anthropic" }),
    listProviders: async () => ok([]),
    getProviderAuthStatus: async () => ok({
      provider: "anthropic",
      available: true,
      state: "connected",
      method: "oauth",
      guidance: null,
    }),
    handleCommand: async () => ok({
      provider: "anthropic",
      action: "status",
      message: "ok",
      status: "connected",
    }),
  } as unknown as ProviderAuthService;
}

function createModelRouterStub(provider: Provider): ModelRouter {
  return {
    routeWithAuthCheck: async () => ok({
      provider,
      model: {
        id: "claude-test",
        name: "Claude Test",
        provider: "anthropic",
        capabilities: ["chat", "streaming"],
        contextWindow: 8_192,
      },
    }),
  } as unknown as ModelRouter;
}

describe("DaemonHttpServer browser system prompt wiring", () => {
  it("includes browser instructions when browser service is active", async () => {
    const provider = createProviderStub();
    const server = new DaemonHttpServer({
      providerAuthService: createAuthServiceStub(),
      modelRouter: createModelRouterStub(provider),
      browserService: {} as BrowserDaemonService,
      conversation: {
        conversationManager: createConversationManagerStub("Base system prompt"),
      },
    });

    let capturedSystemPrompt: string | undefined;
    (server as unknown as {
      conversationManager: ConversationManager;
      generateAndStream: (options: { systemPrompt?: string }) => Promise<{ content: string }>;
      executeProviderGeneration: (context: {
        conversationId: string;
        assistantMessageId: string;
      }) => Promise<void>;
    }).conversationManager = createConversationManagerStub("Base system prompt");

    (server as unknown as {
      generateAndStream: (options: { systemPrompt?: string }) => Promise<{ content: string }>;
    }).generateAndStream = async (options: { systemPrompt?: string }) => {
      capturedSystemPrompt = options.systemPrompt;
      return { content: "assistant response" };
    };

    await (server as unknown as {
      executeProviderGeneration: (context: {
        conversationId: string;
        assistantMessageId: string;
      }) => Promise<void>;
    }).executeProviderGeneration({
      conversationId: "conv-1",
      assistantMessageId: "assistant-1",
    });

    expect(capturedSystemPrompt).toContain(BROWSER_SYSTEM_PROMPT);
  });

  it("does not include browser instructions when browser service is unavailable", async () => {
    const provider = createProviderStub();
    const basePrompt = "Base system prompt";
    const server = new DaemonHttpServer({
      providerAuthService: createAuthServiceStub(),
      modelRouter: createModelRouterStub(provider),
      conversation: {
        conversationManager: createConversationManagerStub(basePrompt),
      },
    });

    let capturedSystemPrompt: string | undefined;
    (server as unknown as {
      conversationManager: ConversationManager;
      generateAndStream: (options: { systemPrompt?: string }) => Promise<{ content: string }>;
      executeProviderGeneration: (context: {
        conversationId: string;
        assistantMessageId: string;
      }) => Promise<void>;
    }).conversationManager = createConversationManagerStub(basePrompt);

    (server as unknown as {
      generateAndStream: (options: { systemPrompt?: string }) => Promise<{ content: string }>;
    }).generateAndStream = async (options: { systemPrompt?: string }) => {
      capturedSystemPrompt = options.systemPrompt;
      return { content: "assistant response" };
    };

    await (server as unknown as {
      executeProviderGeneration: (context: {
        conversationId: string;
        assistantMessageId: string;
      }) => Promise<void>;
    }).executeProviderGeneration({
      conversationId: "conv-1",
      assistantMessageId: "assistant-1",
    });

    expect(capturedSystemPrompt).toBe(basePrompt);
    expect(capturedSystemPrompt).not.toContain(BROWSER_SYSTEM_PROMPT);
  });
});
