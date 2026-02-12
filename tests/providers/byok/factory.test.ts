import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../../src/errors";
import { KeyEncryption } from "../../../src/providers/byok/crypto";
import { BYOKProviderFactory } from "../../../src/providers/byok/factory";
import { BYOKManager } from "../../../src/providers/byok/manager";
import { InMemoryKeyStorage } from "../../../src/providers/byok/storage";

describe("BYOKProviderFactory", () => {
  it("creates provider from stored key and tracks usage", async () => {
    const storage = new InMemoryKeyStorage();
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage,
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    const stored = await manager.addKey({ provider: "openai", apiKey: "sk-factory" });
    const factory = new BYOKProviderFactory(manager);

    const provider = await factory.createProvider(stored.id);

    expect(provider.config.id).toBe("byok-openai");

    const updated = await storage.get(stored.id);
    expect(updated?.usageCount).toBe(1);
  });

  it("creates provider by type for each supported provider", () => {
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage: new InMemoryKeyStorage(),
      fetchFn: async () => new Response(null, { status: 200 }),
    });
    const factory = new BYOKProviderFactory(manager);

    expect(factory.createProviderByType("anthropic", "k").config.id).toBe("byok-anthropic");
    expect(factory.createProviderByType("openai", "k").config.id).toBe("byok-openai");
    expect(factory.createProviderByType("google", "k").config.id).toBe("byok-google");
  });

  it("lists available providers with valid keys", async () => {
    const storage = new InMemoryKeyStorage();
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage,
      fetchFn: async () => new Response(null, { status: 200 }),
    });

    const openaiKey = await manager.addKey({ provider: "openai", apiKey: "sk-valid" });
    const anthropicKey = await manager.addKey({ provider: "anthropic", apiKey: "ak-valid" });
    await storage.updateValidation(anthropicKey.id, false);

    const providers = await BYOKProviderFactory.listAvailableProviders(manager);
    expect(providers).toContain("openai");
    expect(providers).not.toContain("anthropic");

    await manager.removeKey(openaiKey.id);
    const afterRemoval = await BYOKProviderFactory.listAvailableProviders(manager);
    expect(afterRemoval).not.toContain("openai");
  });

  it("throws for unsupported provider type", () => {
    const manager = new BYOKManager({
      encryption: new KeyEncryption("master-secret"),
      storage: new InMemoryKeyStorage(),
      fetchFn: async () => new Response(null, { status: 200 }),
    });
    const factory = new BYOKProviderFactory(manager);

    expect(() => factory.createProviderByType("unsupported", "k")).toThrow(ProviderError);
  });
});
