import { describe, expect, it } from "bun:test";

import { ProviderError } from "../../src/errors";
import { MockProvider } from "../../src/providers/mock";
import { ProviderRegistry } from "../../src/providers/registry";
import { ModelRouter } from "../../src/providers/router";
import type { Model } from "../../src/types";

const makeModel = (id: string, provider: string, capabilities: Model["capabilities"]): Model => ({
  id,
  name: id,
  provider,
  contextWindow: 4096,
  capabilities,
});

describe("ModelRouter", () => {
  it("routes directly when provider and model are specified", async () => {
    const registry = new ProviderRegistry();
    const primary = new MockProvider({
      config: { id: "primary" },
      models: [makeModel("alpha", "primary", ["chat"])],
    });

    registry.register(primary);

    const router = new ModelRouter(registry);
    const route = await router.route({ provider: "primary", model: "alpha" });

    expect(route.provider).toBe(primary);
    expect(route.model.id).toBe("alpha");
  });

  it("routes by model across providers", async () => {
    const registry = new ProviderRegistry();
    const first = new MockProvider({
      config: { id: "first" },
      models: [makeModel("first-model", "first", ["chat"])],
    });
    const second = new MockProvider({
      config: { id: "second" },
      models: [makeModel("target-model", "second", ["chat", "streaming"])],
    });

    registry.register(first);
    registry.register(second);

    const router = new ModelRouter(registry);
    const route = await router.route({ model: "target-model" });

    expect(route.provider).toBe(second);
    expect(route.model.id).toBe("target-model");
  });

  it("routes by capabilities when requested", async () => {
    const registry = new ProviderRegistry();
    const basic = new MockProvider({
      config: { id: "basic" },
      models: [makeModel("basic-model", "basic", ["chat"])],
    });
    const advanced = new MockProvider({
      config: { id: "advanced" },
      models: [makeModel("advanced-model", "advanced", ["chat", "streaming", "tool_use"])],
    });

    registry.register(basic);
    registry.register(advanced);

    const router = new ModelRouter(registry);
    const route = await router.route({ capabilities: ["chat", "streaming", "tool_use"] });

    expect(route.provider).toBe(advanced);
    expect(route.model.id).toBe("advanced-model");
  });

  it("uses first provider and first model when no preference is provided", async () => {
    const registry = new ProviderRegistry();
    const first = new MockProvider({
      config: { id: "first" },
      models: [makeModel("first-default", "first", ["chat"])],
    });
    const second = new MockProvider({
      config: { id: "second" },
      models: [makeModel("second-default", "second", ["chat"])],
    });

    registry.register(first);
    registry.register(second);

    const router = new ModelRouter(registry);
    const route = await router.route({});

    expect(route.provider).toBe(first);
    expect(route.model.id).toBe("first-default");
  });

  it("throws when registry is empty", async () => {
    const router = new ModelRouter(new ProviderRegistry());

    await expect(router.route({})).rejects.toThrow(ProviderError);
  });

  it("throws when provider is missing", async () => {
    const router = new ModelRouter(new ProviderRegistry());

    await expect(router.route({ provider: "missing", model: "x" })).rejects.toThrow(ProviderError);
  });

  it("throws when provider exists but has no matching model", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new MockProvider({
        config: { id: "primary" },
        models: [makeModel("alpha", "primary", ["chat"])],
      }),
    );

    const router = new ModelRouter(registry);

    await expect(router.route({ provider: "primary", model: "missing-model" })).rejects.toThrow(
      ProviderError,
    );
  });

  it("throws when capability match does not exist", async () => {
    const registry = new ProviderRegistry();
    registry.register(
      new MockProvider({
        config: { id: "only-chat" },
        models: [makeModel("chat-model", "only-chat", ["chat"])],
      }),
    );

    const router = new ModelRouter(registry);

    await expect(router.route({ capabilities: ["vision"] })).rejects.toThrow(ProviderError);
  });
});
