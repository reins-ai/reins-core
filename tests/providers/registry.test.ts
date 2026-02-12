import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../src/errors";
import { MockProvider } from "../../src/providers";
import { ProviderRegistry } from "../../src/providers/registry";

describe("ProviderRegistry", () => {
  it("registers and gets a provider by id", () => {
    const registry = new ProviderRegistry();
    const provider = new MockProvider({ config: { id: "primary" } });

    registry.register(provider);

    expect(registry.get("primary")).toBe(provider);
    expect(registry.has("primary")).toBe(true);
  });

  it("throws on duplicate provider id", () => {
    const registry = new ProviderRegistry();

    registry.register(new MockProvider({ config: { id: "duplicate" } }));

    expect(() => registry.register(new MockProvider({ config: { id: "duplicate" } }))).toThrow(
      ProviderError,
    );
  });

  it("returns all providers in registration order", () => {
    const registry = new ProviderRegistry();
    const first = new MockProvider({ config: { id: "first" } });
    const second = new MockProvider({ config: { id: "second" } });

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toEqual([first, second]);
  });

  it("getOrThrow returns provider when present", () => {
    const registry = new ProviderRegistry();
    const provider = new MockProvider({ config: { id: "available" } });
    registry.register(provider);

    expect(registry.getOrThrow("available")).toBe(provider);
  });

  it("getOrThrow throws for unknown provider", () => {
    const registry = new ProviderRegistry();

    expect(() => registry.getOrThrow("missing")).toThrow(ProviderError);
  });

  it("removes providers and returns whether provider existed", () => {
    const registry = new ProviderRegistry();
    registry.register(new MockProvider({ config: { id: "temporary" } }));

    expect(registry.remove("temporary")).toBe(true);
    expect(registry.remove("temporary")).toBe(false);
    expect(registry.has("temporary")).toBe(false);
  });

  it("clears all providers", () => {
    const registry = new ProviderRegistry();
    registry.register(new MockProvider({ config: { id: "p1" } }));
    registry.register(new MockProvider({ config: { id: "p2" } }));

    registry.clear();

    expect(registry.list()).toHaveLength(0);
    expect(registry.has("p1")).toBe(false);
    expect(registry.has("p2")).toBe(false);
  });

  it("exposes built-in capability metadata for local providers", () => {
    const registry = new ProviderRegistry();

    expect(registry.getCapabilities("ollama")).toEqual({
      authModes: [],
      requiresAuth: false,
      userConfigurable: true,
      baseUrl: "http://localhost:11434",
    });
    expect(registry.getCapabilities("vllm")).toEqual({
      authModes: [],
      requiresAuth: false,
      userConfigurable: true,
      baseUrl: "http://localhost:8000",
    });
    expect(registry.getCapabilities("lmstudio")).toEqual({
      authModes: [],
      requiresAuth: false,
      userConfigurable: true,
      baseUrl: "http://localhost:1234",
    });
  });

  it("registers and returns explicit provider capabilities", () => {
    const registry = new ProviderRegistry();

    registry.registerCapabilities("custom-gateway", {
      authModes: ["api_key"],
      requiresAuth: true,
      envVars: ["CUSTOM_GATEWAY_KEY"],
      baseUrl: "https://gateway.example.com",
    });

    expect(registry.getCapabilities("custom-gateway")).toEqual({
      authModes: ["api_key"],
      requiresAuth: true,
      userConfigurable: true,
      envVars: ["CUSTOM_GATEWAY_KEY"],
      baseUrl: "https://gateway.example.com",
    });
  });

  it("stores capabilities from provider config when registering provider", () => {
    const registry = new ProviderRegistry();
    const provider = new MockProvider({
      config: {
        id: "provider-with-capabilities",
        capabilities: {
          authModes: ["api_key", "oauth"],
          requiresAuth: true,
          envVars: ["PROVIDER_KEY"],
        },
      },
    });

    registry.register(provider);

    expect(registry.getCapabilities("provider-with-capabilities")).toEqual({
      authModes: ["api_key", "oauth"],
      requiresAuth: true,
      userConfigurable: true,
      envVars: ["PROVIDER_KEY"],
      baseUrl: undefined,
    });
  });

  it("returns user-configurable capability metadata without fireworks", () => {
    const registry = new ProviderRegistry();

    const userConfigurableProviderIds = registry
      .listUserConfigurableCapabilities()
      .map((entry) => entry.providerId);

    expect(userConfigurableProviderIds).toContain("anthropic");
    expect(userConfigurableProviderIds).not.toContain("fireworks");
  });

  it("filters non-user-configurable providers from provider instance listings", () => {
    const registry = new ProviderRegistry();
    const fireworks = new MockProvider({ config: { id: "fireworks", type: "gateway" } });
    const anthropic = new MockProvider({ config: { id: "anthropic", type: "oauth" } });

    registry.register(fireworks);
    registry.register(anthropic);

    const listedProviderIds = registry.getUserConfigurableProviders().map((provider) => provider.config.id);

    expect(listedProviderIds).toEqual(["anthropic"]);
  });
});
