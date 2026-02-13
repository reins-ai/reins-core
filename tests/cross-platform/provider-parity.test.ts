import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KeyEncryption } from "../../src/providers/byok/crypto";
import { BYOKProviderFactory } from "../../src/providers/byok/factory";
import { BYOKManager } from "../../src/providers/byok/manager";
import { InMemoryKeyStorage } from "../../src/providers/byok/storage";
import { MockProvider } from "../../src/providers/mock";
import { ModelRouter, ProviderRegistry } from "../../src/providers";
import { ProviderAuthService } from "../../src/providers/auth-service";
import { EncryptedCredentialStore } from "../../src/providers/credentials/store";
import type { Model } from "../../src/types";

type Platform = "tui" | "desktop" | "mobile";

const platforms: Platform[] = ["tui", "desktop", "mobile"];
const originalFetch = globalThis.fetch;

const baseModel: Model = {
  id: "shared-model",
  name: "Shared Model",
  provider: "gateway-primary",
  contextWindow: 8192,
  capabilities: ["chat", "streaming"],
};

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createRouterForParity(): ModelRouter {
  const registry = new ProviderRegistry();

  const gatewayPrimary = new MockProvider({
    config: { id: "gateway-primary", name: "Gateway Primary", type: "gateway" },
    models: [baseModel],
  });

  const gatewayFallback = new MockProvider({
    config: { id: "gateway-fallback", name: "Gateway Fallback", type: "gateway" },
    models: [
      {
        ...baseModel,
        id: "fallback-model",
        provider: "gateway-fallback",
      },
    ],
  });

  registry.register(gatewayPrimary);
  registry.register(gatewayFallback);

  return new ModelRouter(registry);
}

describe("cross-platform/provider-parity", () => {
  it("excludes fireworks from user-configurable provider metadata", () => {
    const registry = new ProviderRegistry();

    const userConfigurableProviderIds = registry
      .listUserConfigurableCapabilities()
      .map((entry) => entry.providerId);

    expect(userConfigurableProviderIds).not.toContain("fireworks");
    expect(userConfigurableProviderIds).toContain("anthropic");
    expect(userConfigurableProviderIds).toContain("reins-gateway");
    expect(registry.getCapabilities("fireworks")?.userConfigurable).toBe(false);
  });

  it("excludes fireworks from auth service listProviders response", async () => {
    const tempDirectory = await mkdtemp(join(tmpdir(), "reins-parity-auth-"));

    try {
      const store = new EncryptedCredentialStore({
        encryptionSecret: "parity-test-secret",
        filePath: join(tempDirectory, "credentials.enc.json"),
      });
      const registry = new ProviderRegistry();
      const service = new ProviderAuthService({ store, registry });

      const listResult = await service.listProviders();
      expect(listResult.ok).toBe(true);
      if (!listResult.ok) {
        return;
      }

      const providerIds = listResult.value.map((status) => status.provider);
      expect(providerIds).not.toContain("fireworks");
      expect(providerIds).toContain("anthropic");
      expect(providerIds).toContain("openai");
      expect(providerIds).toContain("ollama");
    } finally {
      await rm(tempDirectory, { recursive: true, force: true });
    }
  });

  it("keeps fireworks capability metadata available for internal routing", () => {
    const registry = new ProviderRegistry();
    const fireworksCapabilities = registry.getCapabilities("fireworks");

    expect(fireworksCapabilities).toBeDefined();
    expect(fireworksCapabilities).toEqual({
      authModes: ["api_key"],
      requiresAuth: true,
      userConfigurable: false,
      baseUrl: "https://api.fireworks.ai/inference/v1",
      envVars: undefined,
    });
  });

  it("selects the same provider for the same model configuration", async () => {
    const baselineRouter = createRouterForParity();
    const baselineRoute = await baselineRouter.route({
      model: "shared-model",
      capabilities: ["chat", "streaming"],
    });

    for (const _platform of platforms.slice(1)) {
      const router = createRouterForParity();
      const route = await router.route({
        model: "shared-model",
        capabilities: ["chat", "streaming"],
      });

      expect(route.provider.config.id).toBe(baselineRoute.provider.config.id);
      expect(route.model.id).toBe(baselineRoute.model.id);
    }
  });

  it("routes BYOK keys to the same provider implementation", async () => {
    const results: Array<{ providerId: string; providerType: string }> = [];

    for (const platform of platforms) {
      const manager = new BYOKManager({
        encryption: new KeyEncryption(`master-${platform}`),
        storage: new InMemoryKeyStorage(),
        fetchFn: async () => new Response(null, { status: 200 }),
      });
      const key = await manager.addKey({ provider: "openai", apiKey: `sk-${platform}-custom-key` });
      const factory = new BYOKProviderFactory(manager);
      const provider = await factory.createProvider(key.id);

      results.push({ providerId: provider.config.id, providerType: provider.config.type });
    }

    expect(results).toEqual([
      { providerId: "byok-openai", providerType: "byok" },
      { providerId: "byok-openai", providerType: "byok" },
      { providerId: "byok-openai", providerType: "byok" },
    ]);
  });

  it("falls back to gateway when BYOK is not available", async () => {
    const fallbackSelections: string[] = [];

    for (const _platform of platforms) {
      const registry = new ProviderRegistry();
      const unavailableByok = new MockProvider({
        config: { id: "byok-openai", name: "BYOK OpenAI", type: "byok" },
        models: [
          {
            id: "byok-model",
            name: "BYOK Model",
            provider: "byok-openai",
            contextWindow: 4096,
            capabilities: ["chat"],
          },
        ],
      });

      const gateway = new MockProvider({
        config: { id: "gateway-primary", name: "Gateway", type: "gateway" },
        models: [
          {
            id: "gateway-model",
            name: "Gateway Model",
            provider: "gateway-primary",
            contextWindow: 8192,
            capabilities: ["chat", "streaming"],
          },
        ],
      });

      registry.register(unavailableByok);
      registry.register(gateway);

      const router = new ModelRouter(registry);
      const route = await router.route({ capabilities: ["chat", "streaming"] });
      fallbackSelections.push(route.provider.config.id);
    }

    expect(fallbackSelections).toEqual(["gateway-primary", "gateway-primary", "gateway-primary"]);
  });

  it("lists models deterministically", async () => {
    const listedModelsPerPlatform: string[][] = [];

    for (const platform of platforms) {
      const registry = new ProviderRegistry();
      const provider = new MockProvider({
        config: { id: `provider-${platform}`, name: `Provider ${platform}`, type: "gateway" },
        models: [
          {
            id: "alpha",
            name: "Alpha",
            provider: `provider-${platform}`,
            contextWindow: 4096,
            capabilities: ["chat"],
          },
          {
            id: "beta",
            name: "Beta",
            provider: `provider-${platform}`,
            contextWindow: 4096,
            capabilities: ["chat", "streaming"],
          },
        ],
      });

      registry.register(provider);
      const models = await provider.listModels();
      listedModelsPerPlatform.push(models.map((candidate) => candidate.id));
    }

    expect(listedModelsPerPlatform[0]).toEqual(["alpha", "beta"]);
    expect(listedModelsPerPlatform[1]).toEqual(["alpha", "beta"]);
    expect(listedModelsPerPlatform[2]).toEqual(["alpha", "beta"]);
  });
});
