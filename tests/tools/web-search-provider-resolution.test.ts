import { describe, expect, it } from "bun:test";

import {
  resolveSearchProviderName,
  SearchProviderResolver,
  type SearchKeyProvider,
} from "../../src/tools/web-search/provider-resolver";
import { createSearchProviderAdapter } from "../../src/tools/web-search/provider-factory";
import {
  BRAVE_CAPABILITIES,
  EXA_CAPABILITIES,
} from "../../src/tools/web-search/provider-contract";
import { BraveAdapter } from "../../src/tools/web-search/providers/brave-adapter";
import { ExaAdapter } from "../../src/tools/web-search/providers/exa-adapter";

function createMockKeyProvider(keys: Record<string, string>): SearchKeyProvider {
  return {
    async getKeyForProvider(name: string) {
      return keys[name] ?? null;
    },
  };
}

describe("resolveSearchProviderName", () => {
  it("returns brave when preference is undefined", () => {
    expect(resolveSearchProviderName(undefined)).toBe("brave");
  });

  it("returns brave when preference is empty string", () => {
    expect(resolveSearchProviderName("")).toBe("brave");
  });

  it("returns brave when preference is invalid string", () => {
    expect(resolveSearchProviderName("google")).toBe("brave");
  });

  it("returns brave when preference is brave", () => {
    expect(resolveSearchProviderName("brave")).toBe("brave");
  });

  it("returns exa when preference is exa", () => {
    expect(resolveSearchProviderName("exa")).toBe("exa");
  });
});

describe("SearchProviderResolver", () => {
  it("resolves brave adapter when key is available", async () => {
    const keyProvider = createMockKeyProvider({ brave_search: "test-brave-key" });
    const resolver = new SearchProviderResolver({ keyProvider });

    const result = await resolver.resolve("brave");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.capabilities.name).toBe("brave");
  });

  it("resolves exa adapter when key is available", async () => {
    const keyProvider = createMockKeyProvider({ exa: "test-exa-key" });
    const resolver = new SearchProviderResolver({ keyProvider });

    const result = await resolver.resolve("exa");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.capabilities.name).toBe("exa");
  });

  it("returns error when no key for brave", async () => {
    const keyProvider = createMockKeyProvider({});
    const resolver = new SearchProviderResolver({ keyProvider });

    const result = await resolver.resolve("brave");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.message).toContain("brave");
    expect(result.error.message).toContain("brave_search");
  });

  it("returns error when no key for exa", async () => {
    const keyProvider = createMockKeyProvider({});
    const resolver = new SearchProviderResolver({ keyProvider });

    const result = await resolver.resolve("exa");
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.message).toContain("exa");
  });

  it("brave adapter has correct capabilities", async () => {
    const keyProvider = createMockKeyProvider({ brave_search: "test-key" });
    const resolver = new SearchProviderResolver({ keyProvider });

    const result = await resolver.resolve("brave");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const caps = result.value.capabilities;
    expect(caps.name).toBe("brave");
    expect(caps.text).toBe(true);
    expect(caps.image).toBe(true);
    expect(caps.video).toBe(true);
    expect(caps.news).toBe(true);
  });

  it("exa adapter has correct capabilities", async () => {
    const keyProvider = createMockKeyProvider({ exa: "test-key" });
    const resolver = new SearchProviderResolver({ keyProvider });

    const result = await resolver.resolve("exa");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const caps = result.value.capabilities;
    expect(caps.name).toBe("exa");
    expect(caps.text).toBe(true);
    expect(caps.image).toBe(false);
    expect(caps.video).toBe(false);
    expect(caps.news).toBe(true);
  });

  it("resolveFromPreference with undefined defaults to brave", async () => {
    const keyProvider = createMockKeyProvider({ brave_search: "test-key" });
    const resolver = new SearchProviderResolver({ keyProvider });

    const result = await resolver.resolveFromPreference(undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.capabilities.name).toBe("brave");
  });

  it("resolveFromPreference with exa resolves exa adapter", async () => {
    const keyProvider = createMockKeyProvider({ exa: "test-key" });
    const resolver = new SearchProviderResolver({ keyProvider });

    const result = await resolver.resolveFromPreference("exa");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.capabilities.name).toBe("exa");
  });

  it("resolveFromPreference with invalid preference defaults to brave adapter", async () => {
    const keyProvider = createMockKeyProvider({ brave_search: "test-key" });
    const resolver = new SearchProviderResolver({ keyProvider });

    const result = await resolver.resolveFromPreference("google");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.capabilities.name).toBe("brave");
  });

  it("provider switching resolves both providers with correct capabilities", async () => {
    const keyProvider = createMockKeyProvider({
      brave_search: "test-brave-key",
      exa: "test-exa-key",
    });
    const resolver = new SearchProviderResolver({ keyProvider });

    // Resolve brave first
    const braveResult = await resolver.resolve("brave");
    expect(braveResult.ok).toBe(true);
    if (!braveResult.ok) return;

    expect(braveResult.value.capabilities.name).toBe("brave");
    expect(braveResult.value.capabilities.text).toBe(true);
    expect(braveResult.value.capabilities.image).toBe(true);
    expect(braveResult.value.capabilities.video).toBe(true);
    expect(braveResult.value.capabilities.news).toBe(true);

    // Then resolve exa — same resolver, different provider
    const exaResult = await resolver.resolve("exa");
    expect(exaResult.ok).toBe(true);
    if (!exaResult.ok) return;

    expect(exaResult.value.capabilities.name).toBe("exa");
    expect(exaResult.value.capabilities.text).toBe(true);
    expect(exaResult.value.capabilities.image).toBe(false);
    expect(exaResult.value.capabilities.video).toBe(false);
    expect(exaResult.value.capabilities.news).toBe(true);
  });
});

describe("SearchProviderFactory", () => {
  it("creates BraveAdapter for brave", () => {
    const adapter = createSearchProviderAdapter("brave", "test-key");
    expect(adapter).toBeInstanceOf(BraveAdapter);
  });

  it("creates ExaAdapter for exa", () => {
    const adapter = createSearchProviderAdapter("exa", "test-key");
    expect(adapter).toBeInstanceOf(ExaAdapter);
  });

  it("created adapters have correct capability declarations", () => {
    const braveAdapter = createSearchProviderAdapter("brave", "test-key");
    expect(braveAdapter.capabilities).toEqual(BRAVE_CAPABILITIES);

    const exaAdapter = createSearchProviderAdapter("exa", "test-key");
    expect(exaAdapter.capabilities).toEqual(EXA_CAPABILITIES);
  });
});
