import { describe, expect, it } from "bun:test";

import { validateProviderSetup } from "../../src/onboarding/validation";
import { ProviderRegistry } from "../../src/providers/registry";
import type { Provider, ProviderConfig, ChatRequest, ChatResponse, Model } from "../../src/types";
import type { StreamEvent } from "../../src/types/streaming";

function createMockProvider(overrides?: {
  id?: string;
  validateConnection?: () => Promise<boolean>;
  listModels?: () => Promise<Model[]>;
}): Provider {
  const config: ProviderConfig = {
    id: overrides?.id ?? "test-provider",
    name: "Test Provider",
    type: "byok",
  };

  return {
    config,
    chat: async (_request: ChatRequest): Promise<ChatResponse> => ({
      id: "mock",
      model: "mock",
      content: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "stop",
    }),
    stream: async function* (_request: ChatRequest): AsyncIterable<StreamEvent> {
      yield { type: "done" };
    },
    listModels: overrides?.listModels ?? (async () => []),
    validateConnection: overrides?.validateConnection ?? (async () => true),
  };
}

describe("validateProviderSetup", () => {
  it("returns not configured for unknown provider", async () => {
    const registry = new ProviderRegistry();

    const result = await validateProviderSetup("nonexistent", { registry });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configured).toBe(false);
      expect(result.value.models).toEqual([]);
    }
  });

  it("returns configured with models for a valid provider", async () => {
    const registry = new ProviderRegistry();
    const models: Model[] = [
      {
        id: "claude-3-opus",
        name: "Claude 3 Opus",
        provider: "anthropic",
        contextWindow: 200000,
        capabilities: ["chat", "streaming"],
      },
      {
        id: "claude-3-sonnet",
        name: "Claude 3 Sonnet",
        provider: "anthropic",
        contextWindow: 200000,
        capabilities: ["chat", "streaming"],
      },
    ];

    const provider = createMockProvider({
      id: "anthropic",
      validateConnection: async () => true,
      listModels: async () => models,
    });
    registry.register(provider);

    const result = await validateProviderSetup("anthropic", { registry });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configured).toBe(true);
      expect(result.value.models).toEqual(["claude-3-opus", "claude-3-sonnet"]);
    }
  });

  it("returns not configured when validateConnection returns false", async () => {
    const registry = new ProviderRegistry();
    const provider = createMockProvider({
      id: "broken",
      validateConnection: async () => false,
    });
    registry.register(provider);

    const result = await validateProviderSetup("broken", { registry });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configured).toBe(false);
      expect(result.value.models).toEqual([]);
    }
  });

  it("returns not configured when validateConnection throws", async () => {
    const registry = new ProviderRegistry();
    const provider = createMockProvider({
      id: "throwing",
      validateConnection: async () => {
        throw new Error("Network error");
      },
    });
    registry.register(provider);

    const result = await validateProviderSetup("throwing", { registry });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configured).toBe(false);
      expect(result.value.models).toEqual([]);
    }
  });

  it("returns not configured when listModels throws", async () => {
    const registry = new ProviderRegistry();
    const provider = createMockProvider({
      id: "partial",
      validateConnection: async () => true,
      listModels: async () => {
        throw new Error("API error");
      },
    });
    registry.register(provider);

    const result = await validateProviderSetup("partial", { registry });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configured).toBe(false);
      expect(result.value.models).toEqual([]);
    }
  });

  it("returns configured with empty models when provider has none", async () => {
    const registry = new ProviderRegistry();
    const provider = createMockProvider({
      id: "empty-models",
      validateConnection: async () => true,
      listModels: async () => [],
    });
    registry.register(provider);

    const result = await validateProviderSetup("empty-models", { registry });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configured).toBe(true);
      expect(result.value.models).toEqual([]);
    }
  });

  it("normalizes provider ID case for lookup", async () => {
    const registry = new ProviderRegistry();
    const provider = createMockProvider({
      id: "anthropic",
      validateConnection: async () => true,
      listModels: async () => [
        {
          id: "claude-3",
          name: "Claude 3",
          provider: "anthropic",
          contextWindow: 200000,
          capabilities: ["chat"],
        },
      ],
    });
    registry.register(provider);

    const result = await validateProviderSetup("Anthropic", { registry });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.configured).toBe(true);
      expect(result.value.models).toEqual(["claude-3"]);
    }
  });
});
