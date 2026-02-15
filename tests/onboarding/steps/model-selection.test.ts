import { describe, expect, it } from "bun:test";

import {
  ModelSelectionStep,
  type AvailableModel,
} from "../../../src/onboarding/steps/model-selection";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import type { OnboardingConfig } from "../../../src/onboarding/types";

function createContext(
  mode: "quickstart" | "advanced",
  overrides?: Partial<StepExecutionContext>,
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
    collectedData: {},
    ...overrides,
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

  it("returns null modelId with autoSelected from getDefaults", () => {
    const step = new ModelSelectionStep();
    const defaults = step.getDefaults();
    expect(defaults.modelId).toBeNull();
    expect(defaults.autoSelected).toBe(true);
  });

  it("auto-selects first available model in quickstart mode", async () => {
    const step = new ModelSelectionStep({
      listModels: async () => MOCK_MODELS,
    });
    const context = createContext("quickstart");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data!.modelId).toBe("claude-sonnet-4-20250514");
    expect(result.data!.provider).toBe("anthropic");
    expect(result.data!.autoSelected).toBe(true);
  });

  it("returns full model list without selection in advanced mode", async () => {
    const step = new ModelSelectionStep({
      listModels: async () => MOCK_MODELS,
    });
    const context = createContext("advanced");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data!.modelId).toBeNull();
    expect(result.data!.provider).toBeNull();
    expect(result.data!.autoSelected).toBe(false);
    expect(result.data!.availableModels).toEqual(MOCK_MODELS);
  });

  it("returns null modelId when no models are available", async () => {
    const step = new ModelSelectionStep({
      listModels: async () => [],
    });
    const context = createContext("quickstart");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data!.modelId).toBeNull();
    expect(result.data!.provider).toBeNull();
    expect(result.data!.autoSelected).toBe(true);
    expect(result.data!.availableModels).toEqual([]);
  });

  it("returns null modelId when no providers are configured (default listModels)", async () => {
    const step = new ModelSelectionStep();
    const context = createContext("quickstart");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data!.modelId).toBeNull();
    expect(result.data!.availableModels).toEqual([]);
  });

  it("includes available models in quickstart result", async () => {
    const step = new ModelSelectionStep({
      listModels: async () => MOCK_MODELS,
    });
    const context = createContext("quickstart");

    const result = await step.execute(context);

    expect(result.data!.availableModels).toEqual(MOCK_MODELS);
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
    expect(result.data!.availableModels).toEqual(singleModel);
  });
});
