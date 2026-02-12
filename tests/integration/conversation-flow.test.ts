import { describe, expect, it } from "bun:test";

import { ConversationManager, InMemoryConversationStore } from "../../src/conversation";
import { ContextManager, DropOldestStrategy } from "../../src/context";
import { ProviderError } from "../../src/errors";
import { DEFAULT_PERSONA, PersonaRegistry, SystemPromptBuilder } from "../../src/persona";
import { MockProvider, ModelRouter, ProviderRegistry } from "../../src/providers";
import type { ChatRequest, Model } from "../../src/types";

const createModel = (providerId: string): Model => ({
  id: "mock-model-1",
  name: "Mock Model",
  provider: providerId,
  contextWindow: 4096,
  capabilities: ["chat", "streaming", "tool_use"],
});

describe("integration/conversation-flow", () => {
  it("runs a complete conversation lifecycle with persona and context preparation", async () => {
    const providerRegistry = new ProviderRegistry();
    const provider = new MockProvider({
      config: { id: "mock-conversation", name: "Mock Conversation", type: "local" },
      models: [createModel("mock-conversation")],
      responseContent: "Absolutely. I can help with that.",
    });
    providerRegistry.register(provider);
    const router = new ModelRouter(providerRegistry);

    const personaRegistry = new PersonaRegistry();
    const builder = new SystemPromptBuilder();
    const persona = personaRegistry.getDefault();

    const conversationStore = new InMemoryConversationStore();
    const conversationManager = new ConversationManager(conversationStore);

    const routed = await router.route({ provider: "mock-conversation", capabilities: ["chat"] });
    const systemPrompt = builder.build({
      persona,
      userContext: "User: Alex",
      currentDate: new Date("2026-02-10T00:00:00.000Z"),
    });

    const conversation = await conversationManager.create({
      title: "Daily planning",
      model: routed.model.id,
      provider: routed.provider.config.id,
      personaId: persona.id,
      systemPrompt,
    });

    const originalUpdatedAt = conversation.updatedAt;
    await Bun.sleep(2);

    await conversationManager.addMessage(conversation.id, {
      role: "user",
      content: "Can you help me plan this afternoon?",
    });

    const history = await conversationManager.getHistory(conversation.id);
    const contextManager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 4096,
    });
    const prepared = contextManager.prepare(history, {
      model: routed.model,
      reservedForOutput: 256,
      systemPrompt,
    });

    expect(prepared).toEqual(history);

    const request: ChatRequest = {
      model: routed.model.id,
      messages: prepared,
      systemPrompt,
    };
    const response = await routed.provider.chat(request);

    await conversationManager.addMessage(conversation.id, {
      role: "assistant",
      content: response.content,
      toolCalls: response.toolCalls,
    });

    const reloaded = await conversationManager.load(conversation.id);

    expect(reloaded.messages).toHaveLength(3);
    expect(reloaded.messages[0]?.role).toBe("system");
    expect(reloaded.messages[1]?.role).toBe("user");
    expect(reloaded.messages[2]?.role).toBe("assistant");
    expect(reloaded.messages[2]?.content).toBe("Absolutely. I can help with that.");
    expect(reloaded.personaId).toBe(DEFAULT_PERSONA.id);
    expect(reloaded.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    expect(reloaded.messages[2]?.createdAt.getTime()).toBeGreaterThanOrEqual(
      reloaded.messages[1]?.createdAt.getTime() ?? 0,
    );

    const reloadedAgain = await conversationStore.load(conversation.id);
    expect(reloadedAgain?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
    expect(reloadedAgain?.messages[0]?.content).toContain("You are Reins");
  });

  it("surfaces provider errors during the conversation request", async () => {
    const providerRegistry = new ProviderRegistry();
    const provider = new MockProvider({
      config: { id: "mock-failing", name: "Mock Failing", type: "local" },
      models: [createModel("mock-failing")],
    });
    providerRegistry.register(provider);
    const router = new ModelRouter(providerRegistry);

    const conversationManager = new ConversationManager(new InMemoryConversationStore());
    const conversation = await conversationManager.create({
      model: "mock-model-1",
      provider: "mock-failing",
      systemPrompt: "System",
    });

    await conversationManager.addMessage(conversation.id, {
      role: "user",
      content: "Hi",
    });

    const routed = await router.route({ provider: "mock-failing", capabilities: ["chat"] });
    const messages = await conversationManager.getHistory(conversation.id);

    await expect(
      routed.provider.chat({
        model: "missing-model",
        messages,
      }),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});
