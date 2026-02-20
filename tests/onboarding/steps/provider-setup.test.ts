import { describe, expect, it } from "bun:test";

import { ProviderSetupStep } from "../../../src/onboarding/steps/provider-setup";
import type {
  ProviderDetectionResult,
  ProviderDisplayInfo,
} from "../../../src/onboarding/steps/provider-setup";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import type { OnboardingConfig } from "../../../src/onboarding/types";
import {
  getProviderSetupCopy,
  PROVIDER_COPY_VARIANTS,
} from "../../../src/onboarding/steps/copy";

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

/** Mock detectProvider that maps known prefixes to providers. */
function mockDetectProvider(key: string): ProviderDetectionResult {
  if (key.startsWith("sk-ant-")) return { providerId: "anthropic" };
  if (key.startsWith("sk-proj-")) return { providerId: "openai" };
  if (key.startsWith("sk-")) return { providerId: "openai" };
  if (key.startsWith("AIza")) return { providerId: "google" };
  if (key.startsWith("fw-")) return { providerId: "fireworks" };
  return { providerId: null };
}

describe("ProviderSetupStep", () => {
  // -----------------------------------------------------------------------
  // Basic properties
  // -----------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Quickstart mode — no key provided (prompt flow)
  // -----------------------------------------------------------------------

  describe("quickstart mode without key", () => {
    it("returns quickstart-prompt flow with copy for TUI", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data!.flow).toBe("quickstart-prompt");
      expect(result.data!.defaultProvider).toBe("anthropic");
    });

    it("includes non-technical copy in prompt flow", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      expect(copy.title).toBeDefined();
      expect(copy.prompt).toBeDefined();
      expect(copy.hint).toBeDefined();
      expect(copy.skipMessage).toBeDefined();
      // Verify copy is non-technical (no raw config keys)
      expect(copy.title).not.toContain("BYOK");
      expect(copy.prompt).not.toContain("config");
    });

    it("uses personality-aware copy when personality is set", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("quickstart", {
        collectedData: { preset: "warm" },
      });

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      const warmCopy = getProviderSetupCopy("warm");
      expect(copy.title).toBe(warmCopy.title);
      expect(copy.prompt).toBe(warmCopy.quickstartPrompt);
    });

    it("uses concise copy for concise personality", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("quickstart", {
        collectedData: { preset: "concise" },
      });

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      const conciseCopy = getProviderSetupCopy("concise");
      expect(copy.title).toBe(conciseCopy.title);
    });

    it("uses technical copy for technical personality", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("quickstart", {
        collectedData: { preset: "technical" },
      });

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      const techCopy = getProviderSetupCopy("technical");
      expect(copy.title).toBe(techCopy.title);
    });

    it("falls back to balanced copy when no personality set", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      const balancedCopy = getProviderSetupCopy("balanced");
      expect(copy.title).toBe(balancedCopy.title);
    });

    it("reads personality from config when not in collectedData", async () => {
      const step = new ProviderSetupStep();
      const config: OnboardingConfig = {
        setupComplete: false,
        mode: "quickstart",
        currentStep: "provider-keys",
        completedSteps: [],
        startedAt: new Date().toISOString(),
        completedAt: null,
        personality: { preset: "warm" },
      };
      const context: StepExecutionContext = {
        mode: "quickstart",
        config,
        collectedData: {},
      };

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      const warmCopy = getProviderSetupCopy("warm");
      expect(copy.title).toBe(warmCopy.title);
    });
  });

  // -----------------------------------------------------------------------
  // Quickstart mode — key provided, auto-detect succeeds
  // -----------------------------------------------------------------------

  describe("quickstart mode with detected key", () => {
    it("returns quickstart-detected flow for Anthropic key", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "sk-ant-abc123" },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data!.flow).toBe("quickstart-detected");
      expect(result.data!.detectedProvider).toBe("anthropic");
      expect(result.data!.providerName).toBe("Anthropic (Claude)");
      expect(result.data!.keyValid).toBe(true);
    });

    it("returns quickstart-detected flow for OpenAI key", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "sk-abc123" },
      });

      const result = await step.execute(context);

      expect(result.data!.detectedProvider).toBe("openai");
      expect(result.data!.providerName).toBe("OpenAI (GPT)");
    });

    it("returns quickstart-detected flow for OpenAI project key (sk-proj-*)", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "sk-proj-abc123" },
      });

      const result = await step.execute(context);

      expect(result.data!.detectedProvider).toBe("openai");
      expect(result.data!.providerName).toBe("OpenAI (GPT)");
    });

    it("returns quickstart-detected flow for Google key", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "AIzaSyAbc123" },
      });

      const result = await step.execute(context);

      expect(result.data!.detectedProvider).toBe("google");
      expect(result.data!.providerName).toBe("Google (Gemini)");
    });

    it("returns quickstart-detected flow for Fireworks key", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "fw-abc123" },
      });

      const result = await step.execute(context);

      expect(result.data!.detectedProvider).toBe("fireworks");
      expect(result.data!.providerName).toBe("Fireworks AI");
    });

    it("includes detected message in copy", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "sk-ant-abc123" },
      });

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      expect(copy.detectedMessage).toContain("Anthropic (Claude)");
    });

    it("validates the key with the detected provider", async () => {
      let validatedProvider = "";
      let validatedKey = "";
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
        validateKey: async (providerId, key) => {
          validatedProvider = providerId;
          validatedKey = key;
          return true;
        },
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "sk-ant-abc123" },
      });

      await step.execute(context);

      expect(validatedProvider).toBe("anthropic");
      expect(validatedKey).toBe("sk-ant-abc123");
    });

    it("reports invalid key when validation fails", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
        validateKey: async () => false,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "sk-ant-invalid" },
      });

      const result = await step.execute(context);

      expect(result.data!.flow).toBe("quickstart-detected");
      expect(result.data!.detectedProvider).toBe("anthropic");
      expect(result.data!.keyValid).toBe(false);
    });

    it("trims whitespace from API key before detection", async () => {
      let detectedKey = "";
      const step = new ProviderSetupStep({
        detectProvider: (key) => {
          detectedKey = key;
          return mockDetectProvider(key);
        },
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "  sk-ant-abc123  " },
      });

      await step.execute(context);

      expect(detectedKey).toBe("sk-ant-abc123");
    });
  });

  // -----------------------------------------------------------------------
  // Quickstart mode — key provided, auto-detect fails (fallback)
  // -----------------------------------------------------------------------

  describe("quickstart mode with unrecognized key", () => {
    it("returns quickstart-fallback flow with provider list", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "unknown-key-format" },
      });

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data!.flow).toBe("quickstart-fallback");
      const providers = result.data!.providers as ProviderDisplayInfo[];
      expect(providers.length).toBe(4);
    });

    it("includes fallback message in copy", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "unknown-key" },
      });

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      expect(copy.fallbackMessage).toBeDefined();
      expect(copy.fallbackMessage.length).toBeGreaterThan(0);
    });

    it("includes provider display info with friendly names", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "unknown-key" },
      });

      const result = await step.execute(context);
      const providers = result.data!.providers as ProviderDisplayInfo[];

      const anthropic = providers.find((p) => p.id === "anthropic");
      expect(anthropic).toBeDefined();
      expect(anthropic!.name).toBe("Anthropic (Claude)");
      expect(anthropic!.description).toBe("Advanced reasoning and analysis");
    });

    it("checks configuration status for fallback providers", async () => {
      const configuredSet = new Set(["openai"]);
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
        isProviderConfigured: async (id) => configuredSet.has(id),
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "unknown-key" },
      });

      const result = await step.execute(context);
      const providers = result.data!.providers as ProviderDisplayInfo[];

      const openai = providers.find((p) => p.id === "openai");
      expect(openai!.configured).toBe(true);

      const anthropic = providers.find((p) => p.id === "anthropic");
      expect(anthropic!.configured).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Quickstart mode — no detectProvider callback (default behavior)
  // -----------------------------------------------------------------------

  describe("quickstart mode without detectProvider callback", () => {
    it("falls back to manual selection when no detectProvider is set", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("quickstart", {
        collectedData: { apiKey: "sk-ant-abc123" },
      });

      const result = await step.execute(context);

      // Default detectProvider returns null, so fallback
      expect(result.data!.flow).toBe("quickstart-fallback");
    });
  });

  // -----------------------------------------------------------------------
  // Advanced mode
  // -----------------------------------------------------------------------

  describe("advanced mode", () => {
    it("returns advanced flow with full provider list", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data!.flow).toBe("advanced");
      const providers = result.data!.providers as ProviderDisplayInfo[];
      expect(providers.length).toBe(4);
    });

    it("includes all default providers with display metadata", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("advanced");

      const result = await step.execute(context);
      const providers = result.data!.providers as ProviderDisplayInfo[];

      const ids = providers.map((p) => p.id);
      expect(ids).toContain("anthropic");
      expect(ids).toContain("openai");
      expect(ids).toContain("google");
      expect(ids).toContain("fireworks");

      // All providers have friendly names (not raw IDs)
      for (const provider of providers) {
        expect(provider.name).not.toBe(provider.id);
        expect(provider.description.length).toBeGreaterThan(0);
      }
    });

    it("includes advanced copy with prompt and skip message", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("advanced");

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      expect(copy.title).toBeDefined();
      expect(copy.prompt).toBeDefined();
      expect(copy.skipMessage).toBeDefined();
      expect(copy.validatingMessage).toBeDefined();
    });

    it("detects already-configured providers", async () => {
      const configuredSet = new Set(["anthropic", "google"]);
      const step = new ProviderSetupStep({
        isProviderConfigured: async (id) => configuredSet.has(id),
      });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const providers = result.data!.providers as ProviderDisplayInfo[];

      const anthropic = providers.find((p) => p.id === "anthropic");
      expect(anthropic!.configured).toBe(true);

      const google = providers.find((p) => p.id === "google");
      expect(google!.configured).toBe(true);

      const openai = providers.find((p) => p.id === "openai");
      expect(openai!.configured).toBe(false);
    });

    it("validates key when provider and key are both provided", async () => {
      let validatedProvider = "";
      const step = new ProviderSetupStep({
        validateKey: async (providerId) => {
          validatedProvider = providerId;
          return true;
        },
      });
      const context = createContext("advanced", {
        collectedData: {
          selectedProvider: "openai",
          apiKey: "sk-abc123",
        },
      });

      const result = await step.execute(context);

      expect(validatedProvider).toBe("openai");
      expect(result.data!.keyValid).toBe(true);
      expect(result.data!.selectedProvider).toBe("openai");
    });

    it("does not validate when only provider is selected (no key)", async () => {
      let validateCalled = false;
      const step = new ProviderSetupStep({
        validateKey: async () => {
          validateCalled = true;
          return true;
        },
      });
      const context = createContext("advanced", {
        collectedData: { selectedProvider: "openai" },
      });

      const result = await step.execute(context);

      expect(validateCalled).toBe(false);
      expect(result.data!.keyValid).toBeUndefined();
    });

    it("does not validate when only key is provided (no provider)", async () => {
      let validateCalled = false;
      const step = new ProviderSetupStep({
        validateKey: async () => {
          validateCalled = true;
          return true;
        },
      });
      const context = createContext("advanced", {
        collectedData: { apiKey: "sk-abc123" },
      });

      const result = await step.execute(context);

      expect(validateCalled).toBe(false);
      expect(result.data!.keyValid).toBeUndefined();
    });

    it("reports invalid key in advanced mode", async () => {
      const step = new ProviderSetupStep({
        validateKey: async () => false,
      });
      const context = createContext("advanced", {
        collectedData: {
          selectedProvider: "openai",
          apiKey: "sk-invalid",
        },
      });

      const result = await step.execute(context);

      expect(result.data!.keyValid).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // Custom available providers
  // -----------------------------------------------------------------------

  describe("custom available providers", () => {
    it("uses custom provider list when provided", async () => {
      const step = new ProviderSetupStep({
        availableProviders: ["openai", "google"],
      });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const providers = result.data!.providers as ProviderDisplayInfo[];

      expect(providers.length).toBe(2);
      expect(providers.map((p) => p.id)).toEqual(["openai", "google"]);
    });

    it("handles unknown provider IDs gracefully in display", async () => {
      const step = new ProviderSetupStep({
        availableProviders: ["custom-provider"],
      });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const providers = result.data!.providers as ProviderDisplayInfo[];

      expect(providers[0].id).toBe("custom-provider");
      expect(providers[0].name).toBe("custom-provider");
      expect(providers[0].description).toBe("");
    });
  });

  // -----------------------------------------------------------------------
  // Copy variants completeness
  // -----------------------------------------------------------------------

  describe("copy variants", () => {
    it("has copy for all personality presets", () => {
      const presets = ["balanced", "concise", "technical", "warm", "custom"] as const;
      for (const preset of presets) {
        const copy = PROVIDER_COPY_VARIANTS[preset];
        expect(copy).toBeDefined();
        expect(copy.title.length).toBeGreaterThan(0);
        expect(copy.quickstartPrompt.length).toBeGreaterThan(0);
        expect(copy.quickstartHint.length).toBeGreaterThan(0);
        expect(copy.advancedPrompt.length).toBeGreaterThan(0);
        expect(copy.fallbackMessage.length).toBeGreaterThan(0);
        expect(copy.validatingMessage.length).toBeGreaterThan(0);
        expect(copy.skipMessage.length).toBeGreaterThan(0);
      }
    });

    it("detectedMessage is a function that includes provider name", () => {
      const presets = ["balanced", "concise", "technical", "warm", "custom"] as const;
      for (const preset of presets) {
        const copy = PROVIDER_COPY_VARIANTS[preset];
        const message = copy.detectedMessage("TestProvider");
        expect(message).toContain("TestProvider");
      }
    });

    it("copy contains no raw config keys or technical jargon in balanced preset", () => {
      const copy = getProviderSetupCopy("balanced");
      const allText = [
        copy.title,
        copy.quickstartPrompt,
        copy.quickstartHint,
        copy.advancedPrompt,
        copy.fallbackMessage,
        copy.validatingMessage,
        copy.skipMessage,
      ].join(" ");

      expect(allText).not.toContain("BYOK");
      expect(allText).not.toContain("config.json");
      expect(allText).not.toContain("environment variable");
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------

  describe("edge cases", () => {
    it("handles empty string apiKey as no key provided", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "" },
      });

      const result = await step.execute(context);

      expect(result.data!.flow).toBe("quickstart-prompt");
    });

    it("handles whitespace-only apiKey as no key provided", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "   " },
      });

      const result = await step.execute(context);

      expect(result.data!.flow).toBe("quickstart-prompt");
    });

    it("handles non-string apiKey as no key provided", async () => {
      const step = new ProviderSetupStep({
        detectProvider: mockDetectProvider,
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: 12345 },
      });

      const result = await step.execute(context);

      expect(result.data!.flow).toBe("quickstart-prompt");
    });

    it("handles unknown provider from detectProvider gracefully", async () => {
      const step = new ProviderSetupStep({
        detectProvider: () => ({ providerId: "unknown-provider" }),
      });
      const context = createContext("quickstart", {
        collectedData: { apiKey: "some-key" },
      });

      const result = await step.execute(context);

      expect(result.data!.flow).toBe("quickstart-detected");
      expect(result.data!.detectedProvider).toBe("unknown-provider");
      // Falls back to raw ID as display name
      expect(result.data!.providerName).toBe("unknown-provider");
    });

    it("handles personalityPreset alias in collectedData", async () => {
      const step = new ProviderSetupStep();
      const context = createContext("quickstart", {
        collectedData: { personalityPreset: "concise" },
      });

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      const conciseCopy = getProviderSetupCopy("concise");
      expect(copy.title).toBe(conciseCopy.title);
    });
  });
});
