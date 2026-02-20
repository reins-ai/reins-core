import { describe, expect, it } from "bun:test";

import { PersonalityStep } from "../../../src/onboarding/steps/personality";
import {
  PERSONALITY_CARDS,
  type PersonalityCardData,
} from "../../../src/onboarding/personality-prompts";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import type { OnboardingConfig, OnboardingMode } from "../../../src/onboarding/types";

function createContext(
  mode: OnboardingMode,
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

  describe("quickstart mode", () => {
    it("returns completed status with balanced preset", async () => {
      const step = new PersonalityStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data).toBeDefined();
      expect(result.data!.preset).toBe("balanced");
    });

    it("auto-selects balanced without requiring user interaction", async () => {
      const step = new PersonalityStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data!.preset).toBe("balanced");
      expect(result.data!.cards).toBeUndefined();
    });

    it("does not include customPrompt in quickstart defaults", async () => {
      const step = new PersonalityStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data!.customPrompt).toBeUndefined();
    });

    it("does not include card data in quickstart mode", async () => {
      const step = new PersonalityStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data!.cards).toBeUndefined();
      expect(result.data!.supportsCustom).toBeUndefined();
    });
  });

  describe("advanced mode", () => {
    it("returns completed status with card data", async () => {
      const step = new PersonalityStep();
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data).toBeDefined();
      expect(result.data!.cards).toBeDefined();
    });

    it("returns all 4 preset cards", async () => {
      const step = new PersonalityStep();
      const context = createContext("advanced");

      const result = await step.execute(context);
      const cards = result.data!.cards as PersonalityCardData[];

      expect(cards).toHaveLength(4);
    });

    it("each card includes preset, label, emoji, description, and exampleResponse", async () => {
      const step = new PersonalityStep();
      const context = createContext("advanced");

      const result = await step.execute(context);
      const cards = result.data!.cards as PersonalityCardData[];

      for (const card of cards) {
        expect(card.preset).toBeTypeOf("string");
        expect(card.label).toBeTypeOf("string");
        expect(card.emoji).toBeTypeOf("string");
        expect(card.description).toBeTypeOf("string");
        expect(card.exampleResponse).toBeTypeOf("string");
        expect(card.emoji.length).toBeGreaterThan(0);
        expect(card.description.length).toBeGreaterThan(0);
        expect(card.exampleResponse.length).toBeGreaterThan(0);
      }
    });

    it("includes balanced, concise, technical, and warm presets", async () => {
      const step = new PersonalityStep();
      const context = createContext("advanced");

      const result = await step.execute(context);
      const cards = result.data!.cards as PersonalityCardData[];
      const presetIds = cards.map((c) => c.preset);

      expect(presetIds).toContain("balanced");
      expect(presetIds).toContain("concise");
      expect(presetIds).toContain("technical");
      expect(presetIds).toContain("warm");
    });

    it("indicates custom input is supported", async () => {
      const step = new PersonalityStep();
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.data!.supportsCustom).toBe(true);
    });

    it("does not include preset field at top level in advanced mode", async () => {
      const step = new PersonalityStep();
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.data!.preset).toBeUndefined();
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

  describe("custom cards override", () => {
    it("uses injected cards instead of built-in ones", async () => {
      const customCards: PersonalityCardData[] = [
        {
          preset: "balanced",
          label: "Test Balanced",
          emoji: "\uD83E\uDDEA",
          description: "Test description",
          exampleResponse: "Test example response",
        },
      ];

      const step = new PersonalityStep({ cards: customCards });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const cards = result.data!.cards as PersonalityCardData[];

      expect(cards).toHaveLength(1);
      expect(cards[0].label).toBe("Test Balanced");
      expect(cards[0].emoji).toBe("\uD83E\uDDEA");
      expect(cards[0].exampleResponse).toBe("Test example response");
    });

    it("custom cards do not affect quickstart mode", async () => {
      const customCards: PersonalityCardData[] = [
        {
          preset: "technical",
          label: "Only Technical",
          emoji: "\uD83D\uDD27",
          description: "Only option",
          exampleResponse: "Only example",
        },
      ];

      const step = new PersonalityStep({ cards: customCards });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data!.preset).toBe("balanced");
      expect(result.data!.cards).toBeUndefined();
    });
  });

  describe("card data quality", () => {
    it("all built-in cards have unique preset identifiers", () => {
      const presetIds = PERSONALITY_CARDS.map((c) => c.preset);
      const uniqueIds = new Set(presetIds);
      expect(uniqueIds.size).toBe(PERSONALITY_CARDS.length);
    });

    it("all built-in cards have unique emoji", () => {
      const emojis = PERSONALITY_CARDS.map((c) => c.emoji);
      const uniqueEmojis = new Set(emojis);
      expect(uniqueEmojis.size).toBe(PERSONALITY_CARDS.length);
    });

    it("all built-in cards have non-empty descriptions", () => {
      for (const card of PERSONALITY_CARDS) {
        expect(card.description.trim().length).toBeGreaterThan(0);
      }
    });

    it("all built-in cards have non-empty example responses", () => {
      for (const card of PERSONALITY_CARDS) {
        expect(card.exampleResponse.trim().length).toBeGreaterThan(0);
      }
    });

    it("example responses demonstrate distinct tones", () => {
      const examples = PERSONALITY_CARDS.map((c) => c.exampleResponse);
      const uniqueExamples = new Set(examples);
      expect(uniqueExamples.size).toBe(PERSONALITY_CARDS.length);
    });
  });
});
