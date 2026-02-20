import { describe, expect, it } from "bun:test";

import type { OnboardingConfig, OnboardingMode } from "../../../src/onboarding/types";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import { WelcomeStep } from "../../../src/onboarding/steps/welcome";
import {
  getWelcomeCopy,
  WELCOME_COPY_VARIANTS,
  type WelcomeCopy,
} from "../../../src/onboarding/steps/copy";

function createContext(
  mode: OnboardingMode = "quickstart",
  overrides?: Partial<StepExecutionContext>,
): StepExecutionContext {
  const config: OnboardingConfig = {
    setupComplete: false,
    mode,
    currentStep: "welcome",
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

describe("WelcomeStep", () => {
  it("is not skippable", () => {
    const step = new WelcomeStep();
    expect(step.skippable).toBe(false);
  });

  it("has step identifier 'welcome'", () => {
    const step = new WelcomeStep();
    expect(step.step).toBe("welcome");
  });

  it("returns defaults with userName and selectedMode", () => {
    const step = new WelcomeStep();
    const defaults = step.getDefaults();

    expect(defaults).toEqual({
      userName: "User",
      selectedMode: "quickstart",
    });
  });

  describe("quickstart mode", () => {
    it("completes with default userName when no reader provided", async () => {
      const step = new WelcomeStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.userName).toBe("User");
      expect(result.data?.selectedMode).toBe("quickstart");
    });

    it("captures real name from reader", async () => {
      const step = new WelcomeStep({
        readUserName: async () => "Alice",
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.userName).toBe("Alice");
      expect(result.data?.selectedMode).toBe("quickstart");
    });

    it("falls back to default when reader returns undefined", async () => {
      const step = new WelcomeStep({
        readUserName: async () => undefined,
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.userName).toBe("User");
    });

    it("trims whitespace from user name", async () => {
      const step = new WelcomeStep({
        readUserName: async () => "  Bob  ",
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data?.userName).toBe("Bob");
    });

    it("falls back to default for empty string name", async () => {
      const step = new WelcomeStep({
        readUserName: async () => "",
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data?.userName).toBe("User");
    });

    it("falls back to default for whitespace-only name", async () => {
      const step = new WelcomeStep({
        readUserName: async () => "   ",
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data?.userName).toBe("User");
    });

    it("includes copy in result data", async () => {
      const step = new WelcomeStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data?.copy).toBeDefined();
      const copy = result.data?.copy as Record<string, string>;
      expect(copy.headline).toBe("Welcome to Reins");
      expect(copy.subtitle).toBeString();
      expect(copy.namePrompt).toBeString();
      expect(copy.namePlaceholder).toBeString();
    });

    it("does not include mode selection copy in quickstart", async () => {
      const step = new WelcomeStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.quickstartLabel).toBeUndefined();
      expect(copy.advancedLabel).toBeUndefined();
    });
  });

  describe("advanced mode", () => {
    it("completes with default name when no reader provided", async () => {
      const step = new WelcomeStep();
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.userName).toBe("User");
      expect(result.data?.selectedMode).toBe("advanced");
      expect(result.data?.channelSetupAvailable).toBe(true);
    });

    it("captures real name from reader", async () => {
      const step = new WelcomeStep({
        readUserName: async () => "Charlie",
      });
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
      expect(result.data?.userName).toBe("Charlie");
      expect(result.data?.selectedMode).toBe("advanced");
    });

    it("falls back to default when reader returns undefined", async () => {
      const step = new WelcomeStep({
        readUserName: async () => undefined,
      });
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.data?.userName).toBe("User");
    });

    it("includes full copy with mode selection options", async () => {
      const step = new WelcomeStep();
      const context = createContext("advanced");

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.headline).toBeString();
      expect(copy.subtitle).toBeString();
      expect(copy.namePrompt).toBeString();
      expect(copy.namePlaceholder).toBeString();
      expect(copy.quickstartLabel).toBeString();
      expect(copy.quickstartDescription).toBeString();
      expect(copy.advancedLabel).toBeString();
      expect(copy.advancedDescription).toBeString();
    });
  });

  describe("personality-aware copy", () => {
    it("uses balanced copy by default", async () => {
      const step = new WelcomeStep();
      const context = createContext("quickstart");

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.headline).toBe("Welcome to Reins");
    });

    it("uses warm copy when preset is warm", async () => {
      const step = new WelcomeStep({ personalityPreset: "warm" });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.headline).toContain("Welcome to Reins");
      expect(copy.subtitle).toContain("excited");
    });

    it("uses technical copy when preset is technical", async () => {
      const step = new WelcomeStep({ personalityPreset: "technical" });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.headline).toBe("Reins Configuration");
    });

    it("uses concise copy when preset is concise", async () => {
      const step = new WelcomeStep({ personalityPreset: "concise" });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.headline).toBe("Reins Setup");
    });

    it("picks up personality preset from context collectedData", async () => {
      const step = new WelcomeStep();
      const context = createContext("quickstart", {
        collectedData: { personalityPreset: "warm" },
      });

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.headline).toContain("Welcome to Reins");
      expect(copy.subtitle).toContain("excited");
    });

    it("prefers context preset over constructor preset", async () => {
      const step = new WelcomeStep({ personalityPreset: "technical" });
      const context = createContext("quickstart", {
        collectedData: { personalityPreset: "warm" },
      });

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.subtitle).toContain("excited");
    });

    it("falls back to constructor preset when context has no personality", async () => {
      const step = new WelcomeStep({ personalityPreset: "concise" });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.headline).toBe("Reins Setup");
    });

    it("falls back to balanced for custom preset", async () => {
      const step = new WelcomeStep({ personalityPreset: "custom" });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      const copy = result.data?.copy as Record<string, string>;
      expect(copy.headline).toBe("Welcome to Reins");
    });
  });

  describe("getCopy", () => {
    it("returns balanced copy with no arguments", () => {
      const step = new WelcomeStep();
      const copy = step.getCopy();

      expect(copy.headline).toBe("Welcome to Reins");
    });

    it("returns copy matching constructor preset", () => {
      const step = new WelcomeStep({ personalityPreset: "warm" });
      const copy = step.getCopy();

      expect(copy.headline).toContain("Welcome to Reins");
      expect(copy.subtitle).toContain("excited");
    });

    it("returns copy matching context preset", () => {
      const step = new WelcomeStep();
      const context = createContext("quickstart", {
        collectedData: { personalityPreset: "technical" },
      });
      const copy = step.getCopy(context);

      expect(copy.headline).toBe("Reins Configuration");
    });
  });
});

describe("getWelcomeCopy", () => {
  it("returns balanced copy by default", () => {
    const copy = getWelcomeCopy();
    expect(copy.headline).toBe("Welcome to Reins");
  });

  it("returns balanced copy for 'balanced' preset", () => {
    const copy = getWelcomeCopy("balanced");
    expect(copy.headline).toBe("Welcome to Reins");
  });

  it("returns concise copy for 'concise' preset", () => {
    const copy = getWelcomeCopy("concise");
    expect(copy.headline).toBe("Reins Setup");
  });

  it("returns technical copy for 'technical' preset", () => {
    const copy = getWelcomeCopy("technical");
    expect(copy.headline).toBe("Reins Configuration");
  });

  it("returns warm copy for 'warm' preset", () => {
    const copy = getWelcomeCopy("warm");
    expect(copy.headline).toContain("Welcome to Reins");
    expect(copy.subtitle).toContain("excited");
  });

  it("returns balanced copy for 'custom' preset", () => {
    const copy = getWelcomeCopy("custom");
    expect(copy.headline).toBe("Welcome to Reins");
  });
});

describe("WELCOME_COPY_VARIANTS", () => {
  const requiredFields: (keyof WelcomeCopy)[] = [
    "headline",
    "subtitle",
    "namePrompt",
    "namePlaceholder",
    "quickstartLabel",
    "quickstartDescription",
    "advancedLabel",
    "advancedDescription",
  ];

  const presets = ["balanced", "concise", "technical", "warm", "custom"] as const;

  for (const preset of presets) {
    it(`has complete copy for '${preset}' preset`, () => {
      const copy = WELCOME_COPY_VARIANTS[preset];
      expect(copy).toBeDefined();

      for (const field of requiredFields) {
        expect(copy[field]).toBeString();
        expect((copy[field] as string).length).toBeGreaterThan(0);
      }
    });
  }

  it("contains no raw config keys or technical jargon in balanced copy", () => {
    const copy = WELCOME_COPY_VARIANTS.balanced;
    const allText = Object.values(copy).join(" ");

    expect(allText).not.toContain("config");
    expect(allText).not.toContain("JSON");
    expect(allText).not.toContain("YAML");
    expect(allText).not.toContain(".json");
    expect(allText).not.toContain("env");
    expect(allText).not.toContain("API");
  });

  it("contains no raw config keys or technical jargon in warm copy", () => {
    const copy = WELCOME_COPY_VARIANTS.warm;
    const allText = Object.values(copy).join(" ");

    expect(allText).not.toContain("config");
    expect(allText).not.toContain("JSON");
    expect(allText).not.toContain("YAML");
    expect(allText).not.toContain(".json");
    expect(allText).not.toContain("env");
    expect(allText).not.toContain("API");
  });
});
