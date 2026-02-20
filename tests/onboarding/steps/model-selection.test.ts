import { describe, expect, it } from "bun:test";

import {
  ModelSelectionStep,
  type AvailableModel,
} from "../../../src/onboarding/steps/model-selection";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import type { OnboardingConfig } from "../../../src/onboarding/types";
import {
  getFriendlyModelName,
  getModelSelectionCopy,
  FRIENDLY_MODEL_NAME_MAP,
  MODEL_SELECTION_COPY_VARIANTS,
} from "../../../src/onboarding/steps/copy";

function createContext(
  mode: "quickstart" | "advanced",
  collectedData: Record<string, unknown> = {},
): StepExecutionContext {
  const config: OnboardingConfig = {
    setupComplete: false,
    mode,
    currentStep: "model-select",
    completedSteps: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
  };

  return {
    mode,
    config,
    collectedData,
  };
}

const MOCK_MODELS: AvailableModel[] = [
  { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", provider: "google" },
];

describe("ModelSelectionStep", () => {
  it("has step identifier 'model-select'", () => {
    const step = new ModelSelectionStep();
    expect(step.step).toBe("model-select");
  });

  it("is skippable", () => {
    const step = new ModelSelectionStep();
    expect(step.skippable).toBe(true);
  });

  it("returns null modelId and displayName with autoSelected from getDefaults", () => {
    const step = new ModelSelectionStep();
    const defaults = step.getDefaults();
    expect(defaults.modelId).toBeNull();
    expect(defaults.displayName).toBeNull();
    expect(defaults.autoSelected).toBe(true);
  });

  describe("quickstart mode", () => {
    it("auto-selects first available model with friendly name", async () => {
      const step = new ModelSelectionStep({
        listModels: async () => MOCK_MODELS,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data!.modelId).toBe("claude-sonnet-4-20250514");
      expect(result.data!.displayName).toBe("Claude Sonnet 4");
      expect(result.data!.provider).toBe("anthropic");
      expect(result.data!.autoSelected).toBe(true);
    });

    it("does not expose raw model IDs in quickstart display data", async () => {
      const rawIdModels: AvailableModel[] = [
        { id: "claude-3-5-sonnet-20241022", name: "claude-3-5-sonnet-20241022", provider: "anthropic" },
      ];
      const step = new ModelSelectionStep({
        listModels: async () => rawIdModels,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      // The displayName should be friendly, not the raw ID
      expect(result.data!.displayName).toBe("Claude 3.5 Sonnet");
      expect(result.data!.displayName).not.toContain("20241022");
    });

    it("includes copy with auto-selected message", async () => {
      const step = new ModelSelectionStep({
        listModels: async () => MOCK_MODELS,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      expect(copy.headline).toBeDefined();
      expect(copy.description).toBeDefined();
      expect(copy.statusMessage).toBeDefined();
      // Should not include selection prompt in quickstart
      expect(copy.selectionPrompt).toBeUndefined();
    });

    it("returns available models with friendly names", async () => {
      const step = new ModelSelectionStep({
        listModels: async () => MOCK_MODELS,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);
      const models = result.data!.availableModels as Array<{ id: string; displayName: string; provider: string }>;

      expect(models).toHaveLength(3);
      expect(models[0].displayName).toBe("Claude Sonnet 4");
      expect(models[1].displayName).toBe("GPT-4o");
      expect(models[2].displayName).toBe("Gemini 2.5 Pro");
    });
  });

  describe("advanced mode", () => {
    it("returns full model list with friendly names without selection", async () => {
      const step = new ModelSelectionStep({
        listModels: async () => MOCK_MODELS,
      });
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data!.modelId).toBeNull();
      expect(result.data!.displayName).toBeNull();
      expect(result.data!.provider).toBeNull();
      expect(result.data!.autoSelected).toBe(false);
    });

    it("includes selection prompt in advanced copy", async () => {
      const step = new ModelSelectionStep({
        listModels: async () => MOCK_MODELS,
      });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      expect(copy.headline).toBeDefined();
      expect(copy.description).toBeDefined();
      expect(copy.selectionPrompt).toBeDefined();
    });

    it("returns all models with friendly display names", async () => {
      const step = new ModelSelectionStep({
        listModels: async () => MOCK_MODELS,
      });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const models = result.data!.availableModels as Array<{ id: string; displayName: string; provider: string }>;

      expect(models).toHaveLength(3);
      for (const model of models) {
        expect(model.id).toBeDefined();
        expect(model.displayName).toBeDefined();
        expect(model.provider).toBeDefined();
        // Display name should not be a raw ID with date suffix
        expect(model.displayName).not.toMatch(/-\d{8}$/);
      }
    });

    it("handles single model in advanced mode", async () => {
      const singleModel: AvailableModel[] = [
        { id: "claude-sonnet-4-20250514", name: "Claude Sonnet 4", provider: "anthropic" },
      ];
      const step = new ModelSelectionStep({
        listModels: async () => singleModel,
      });
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data!.modelId).toBeNull();
      expect(result.data!.autoSelected).toBe(false);
      const models = result.data!.availableModels as Array<{ id: string; displayName: string }>;
      expect(models).toHaveLength(1);
      expect(models[0].displayName).toBe("Claude Sonnet 4");
    });
  });

  describe("empty models", () => {
    it("returns null modelId when no models are available", async () => {
      const step = new ModelSelectionStep({
        listModels: async () => [],
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data!.modelId).toBeNull();
      expect(result.data!.displayName).toBeNull();
      expect(result.data!.provider).toBeNull();
      expect(result.data!.autoSelected).toBe(true);
    });

    it("includes no-models message in copy when empty", async () => {
      const step = new ModelSelectionStep({
        listModels: async () => [],
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);
      const copy = result.data!.copy as Record<string, string>;

      expect(copy.statusMessage).toBeDefined();
      expect(copy.statusMessage.length).toBeGreaterThan(0);
    });

    it("returns null modelId when no providers are configured (default listModels)", async () => {
      const step = new ModelSelectionStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data!.modelId).toBeNull();
      expect(result.data!.availableModels).toEqual([]);
    });
  });

  describe("personality-aware copy", () => {
    it("uses balanced copy by default", () => {
      const step = new ModelSelectionStep();
      const copy = step.getCopy();
      const expected = getModelSelectionCopy("balanced");

      expect(copy.headline).toBe(expected.headline);
      expect(copy.description).toBe(expected.description);
    });

    it("uses personality preset from constructor", () => {
      const step = new ModelSelectionStep({
        personalityPreset: "warm",
      });
      const copy = step.getCopy();
      const expected = getModelSelectionCopy("warm");

      expect(copy.headline).toBe(expected.headline);
    });

    it("uses personality preset from context collectedData", () => {
      const step = new ModelSelectionStep({
        personalityPreset: "balanced",
      });
      const context = createContext("quickstart", { personalityPreset: "technical" });
      const copy = step.getCopy(context);
      const expected = getModelSelectionCopy("technical");

      expect(copy.headline).toBe(expected.headline);
    });

    it("context preset overrides constructor preset", () => {
      const step = new ModelSelectionStep({
        personalityPreset: "warm",
      });
      const context = createContext("quickstart", { personalityPreset: "concise" });
      const copy = step.getCopy(context);
      const expected = getModelSelectionCopy("concise");

      expect(copy.headline).toBe(expected.headline);
    });
  });

  describe("copy content quality", () => {
    it("all personality presets have complete copy", () => {
      const presets = ["balanced", "concise", "technical", "warm", "custom"] as const;

      for (const preset of presets) {
        const copy = MODEL_SELECTION_COPY_VARIANTS[preset];
        expect(copy.headline).toBeTruthy();
        expect(copy.description).toBeTruthy();
        expect(copy.autoSelectedMessage).toBeTruthy();
        expect(copy.selectionPrompt).toBeTruthy();
        expect(copy.noModelsMessage).toBeTruthy();
      }
    });

    it("balanced copy explains model selection in plain language", () => {
      const copy = getModelSelectionCopy("balanced");

      expect(copy.description).toContain("model");
      expect(copy.description).not.toContain("LLM");
      expect(copy.description).not.toContain("API");
    });
  });
});

describe("getFriendlyModelName", () => {
  it("maps known Anthropic model IDs to friendly names", () => {
    expect(getFriendlyModelName("claude-3-5-sonnet-20241022")).toBe("Claude 3.5 Sonnet");
    expect(getFriendlyModelName("claude-3-5-haiku-20241022")).toBe("Claude 3.5 Haiku");
    expect(getFriendlyModelName("claude-sonnet-4-20250514")).toBe("Claude Sonnet 4");
    expect(getFriendlyModelName("claude-3-opus-20240229")).toBe("Claude 3 Opus");
    expect(getFriendlyModelName("claude-3-haiku-20240307")).toBe("Claude 3 Haiku");
  });

  it("maps known OpenAI model IDs to friendly names", () => {
    expect(getFriendlyModelName("gpt-4o")).toBe("GPT-4o");
    expect(getFriendlyModelName("gpt-4o-mini")).toBe("GPT-4o Mini");
    expect(getFriendlyModelName("gpt-4-turbo")).toBe("GPT-4 Turbo");
    expect(getFriendlyModelName("gpt-4")).toBe("GPT-4");
    expect(getFriendlyModelName("gpt-3.5-turbo")).toBe("GPT-3.5 Turbo");
    expect(getFriendlyModelName("o1")).toBe("o1");
    expect(getFriendlyModelName("o1-mini")).toBe("o1 Mini");
  });

  it("maps known Google model IDs to friendly names", () => {
    expect(getFriendlyModelName("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(getFriendlyModelName("gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(getFriendlyModelName("gemini-1.5-pro")).toBe("Gemini 1.5 Pro");
  });

  it("maps known Fireworks model IDs to friendly names", () => {
    expect(getFriendlyModelName("accounts/fireworks/models/llama-v3p1-405b-instruct")).toBe("Llama 3.1 405B");
    expect(getFriendlyModelName("accounts/fireworks/models/llama-v3p1-70b-instruct")).toBe("Llama 3.1 70B");
    expect(getFriendlyModelName("accounts/fireworks/models/mixtral-8x22b-instruct")).toBe("Mixtral 8x22B");
  });

  it("applies heuristic cleanup for unknown model IDs", () => {
    const result = getFriendlyModelName("some-new-model-20250101");
    // Should strip date suffix and title-case
    expect(result).toBe("Some New Model");
  });

  it("strips path prefixes from unknown model IDs", () => {
    const result = getFriendlyModelName("accounts/provider/models/cool-model");
    expect(result).toBe("Cool Model");
  });

  it("handles simple model IDs without date suffix", () => {
    const result = getFriendlyModelName("my-model");
    expect(result).toBe("My Model");
  });

  it("handles single-word model IDs", () => {
    const result = getFriendlyModelName("llama");
    expect(result).toBe("Llama");
  });

  it("covers all entries in the friendly name map", () => {
    for (const [id, expectedName] of Object.entries(FRIENDLY_MODEL_NAME_MAP)) {
      expect(getFriendlyModelName(id)).toBe(expectedName);
    }
  });
});
