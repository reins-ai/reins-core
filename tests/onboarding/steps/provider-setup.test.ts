import { describe, expect, it } from "bun:test";

import { ProviderSetupStep } from "../../../src/onboarding/steps/provider-setup";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import type { OnboardingConfig } from "../../../src/onboarding/types";

function createContext(
  mode: "quickstart" | "advanced",
  overrides?: Partial<StepExecutionContext>,
): StepExecutionContext {
  const config: OnboardingConfig = {
    setupComplete: false,
    mode,
    currentStep: "provider-keys",
    completedSteps: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  return {
    mode,
    config,
    collectedData: {},
    ...overrides,
  };
}

describe("ProviderSetupStep", () => {
  it("has step identifier 'provider-keys'", () => {
    const step = new ProviderSetupStep();
    expect(step.step).toBe("provider-keys");
  });

  it("is skippable", () => {
    const step = new ProviderSetupStep();
    expect(step.skippable).toBe(true);
  });

  it("returns default provider anthropic from getDefaults", () => {
    const step = new ProviderSetupStep();
    const defaults = step.getDefaults();
    expect(defaults.provider).toBe("anthropic");
    expect(defaults.configured).toBe(false);
  });

  it("returns single default provider in quickstart mode", async () => {
    const step = new ProviderSetupStep();
    const context = createContext("quickstart");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data).toBeDefined();
    expect(result.data!.availableProviders).toEqual(["anthropic"]);
    expect(result.data!.defaultProvider).toBe("anthropic");
  });

  it("returns all available providers in advanced mode", async () => {
    const step = new ProviderSetupStep();
    const context = createContext("advanced");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data).toBeDefined();
    const providers = result.data!.availableProviders as string[];
    expect(providers).toContain("anthropic");
    expect(providers).toContain("openai");
    expect(providers).toContain("google");
    expect(providers.length).toBe(3);
  });

  it("uses custom available providers when provided", async () => {
    const step = new ProviderSetupStep({
      availableProviders: ["openai", "google"],
    });
    const context = createContext("advanced");

    const result = await step.execute(context);

    expect(result.data!.availableProviders).toEqual(["openai", "google"]);
    expect(result.data!.defaultProvider).toBe("openai");
  });

  it("detects already-configured providers", async () => {
    const configuredSet = new Set(["anthropic"]);
    const step = new ProviderSetupStep({
      isProviderConfigured: async (id) => configuredSet.has(id),
    });
    const context = createContext("advanced");

    const result = await step.execute(context);

    expect(result.data!.configuredProviders).toEqual(["anthropic"]);
  });

  it("returns empty configured list when no providers are configured", async () => {
    const step = new ProviderSetupStep({
      isProviderConfigured: async () => false,
    });
    const context = createContext("advanced");

    const result = await step.execute(context);

    expect(result.data!.configuredProviders).toEqual([]);
  });

  it("checks only the single quickstart provider for configuration", async () => {
    const checkedProviders: string[] = [];
    const step = new ProviderSetupStep({
      isProviderConfigured: async (id) => {
        checkedProviders.push(id);
        return false;
      },
    });
    const context = createContext("quickstart");

    await step.execute(context);

    expect(checkedProviders).toEqual(["anthropic"]);
  });

  it("checks all providers for configuration in advanced mode", async () => {
    const checkedProviders: string[] = [];
    const step = new ProviderSetupStep({
      isProviderConfigured: async (id) => {
        checkedProviders.push(id);
        return false;
      },
    });
    const context = createContext("advanced");

    await step.execute(context);

    expect(checkedProviders).toContain("anthropic");
    expect(checkedProviders).toContain("openai");
    expect(checkedProviders).toContain("google");
    expect(checkedProviders.length).toBe(3);
  });
});
