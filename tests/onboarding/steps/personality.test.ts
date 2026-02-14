import { describe, expect, it } from "bun:test";

import { PersonalityStep } from "../../../src/onboarding/steps/personality";
import { PERSONALITY_PRESETS } from "../../../src/onboarding/personality-prompts";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import type { OnboardingConfig } from "../../../src/onboarding/types";

function createContext(
  mode: "quickstart" | "advanced",
  overrides?: Partial<StepExecutionContext>,
): StepExecutionContext {
  const config: OnboardingConfig = {
    setupComplete: false,
    mode,
    currentStep: "personality",
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

describe("PersonalityStep", () => {
  it("has step identifier set to personality", () => {
    const step = new PersonalityStep();
    expect(step.step).toBe("personality");
  });

  it("is skippable", () => {
    const step = new PersonalityStep();
    expect(step.skippable).toBe(true);
  });

  describe("execute in quickstart mode", () => {
    it("returns completed status with balanced preset", async () => {
      const step = new PersonalityStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data).toBeDefined();
      expect(result.data!.preset).toBe("balanced");
    });

    it("does not include customPrompt in quickstart defaults", async () => {
      const step = new PersonalityStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data!.customPrompt).toBeUndefined();
    });
  });

  describe("execute in advanced mode", () => {
    it("returns completed status with available presets", async () => {
      const step = new PersonalityStep();
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data).toBeDefined();
      expect(result.data!.availablePresets).toBeDefined();
    });

    it("provides all built-in presets for TUI selection", async () => {
      const step = new PersonalityStep();
      const context = createContext("advanced");

      const result = await step.execute(context);
      const presets = result.data!.availablePresets as Array<{
        preset: string;
        label: string;
        description: string;
      }>;

      expect(presets).toHaveLength(PERSONALITY_PRESETS.length);
      for (const preset of presets) {
        expect(preset.preset).toBeTypeOf("string");
        expect(preset.label).toBeTypeOf("string");
        expect(preset.description).toBeTypeOf("string");
      }
    });

    it("indicates custom input is supported", async () => {
      const step = new PersonalityStep();
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.data!.supportsCustom).toBe(true);
    });
  });

  describe("getDefaults", () => {
    it("returns balanced as the default preset", () => {
      const step = new PersonalityStep();
      const defaults = step.getDefaults();

      expect(defaults.preset).toBe("balanced");
    });

    it("returns undefined for customPrompt", () => {
      const step = new PersonalityStep();
      const defaults = step.getDefaults();

      expect(defaults.customPrompt).toBeUndefined();
    });
  });

  describe("custom presets override", () => {
    it("uses injected presets instead of built-in ones", async () => {
      const customPresets = [
        {
          preset: "balanced" as const,
          label: "Test Balanced",
          description: "Test description",
          systemPromptModifier: "Test modifier",
        },
      ];

      const step = new PersonalityStep({ presets: customPresets });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const presets = result.data!.availablePresets as Array<{
        preset: string;
        label: string;
      }>;

      expect(presets).toHaveLength(1);
      expect(presets[0].label).toBe("Test Balanced");
    });
  });

  describe("all presets produce distinct modifiers", () => {
    it("each built-in preset has a unique system prompt modifier", () => {
      const modifiers = PERSONALITY_PRESETS.map((p) => p.systemPromptModifier);
      const uniqueModifiers = new Set(modifiers);
      expect(uniqueModifiers.size).toBe(PERSONALITY_PRESETS.length);
    });
  });
});
