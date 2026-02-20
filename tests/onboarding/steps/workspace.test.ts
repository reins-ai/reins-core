import { describe, expect, it } from "bun:test";

import { WorkspaceStep } from "../../../src/onboarding/steps/workspace";
import {
  getWorkspaceCopy,
  WORKSPACE_COPY_VARIANTS,
} from "../../../src/onboarding/steps/copy";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import type { OnboardingConfig, OnboardingMode, PersonalityPreset } from "../../../src/onboarding/types";

const DEFAULT_PATH = "/test/reins-workspace";

function createContext(
  mode: OnboardingMode,
  overrides?: Partial<StepExecutionContext>,
): StepExecutionContext {
  const config: OnboardingConfig = {
    setupComplete: false,
    mode,
    currentStep: "workspace",
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

describe("WorkspaceStep", () => {
  it("has step identifier set to workspace", () => {
    const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
    expect(step.step).toBe("workspace");
  });

  it("is skippable", () => {
    const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
    expect(step.skippable).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // getDefaults
  // ---------------------------------------------------------------------------

  describe("getDefaults", () => {
    it("returns the default workspace path", () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const defaults = step.getDefaults();

      expect(defaults.workspacePath).toBe(DEFAULT_PATH);
    });

    it("uses ~/reins-workspace when no override is provided", () => {
      const step = new WorkspaceStep();
      const defaults = step.getDefaults();

      expect(typeof defaults.workspacePath).toBe("string");
      expect((defaults.workspacePath as string).endsWith("reins-workspace")).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // execute — quickstart mode
  // ---------------------------------------------------------------------------

  describe("execute in quickstart mode", () => {
    it("returns completed status", async () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
    });

    it("returns the default workspace path", async () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data?.workspacePath).toBe(DEFAULT_PATH);
    });

    it("includes copy in the result data", async () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const context = createContext("quickstart");

      const result = await step.execute(context);

      expect(result.data?.copy).toBeDefined();
    });

    it("includes headline, description, benefit, and defaultPathLabel in quickstart copy", async () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const context = createContext("quickstart");

      const result = await step.execute(context);
      const copy = result.data?.copy as Record<string, string>;

      expect(typeof copy.headline).toBe("string");
      expect(typeof copy.description).toBe("string");
      expect(typeof copy.benefit).toBe("string");
      expect(typeof copy.defaultPathLabel).toBe("string");
    });

    it("does not include customPathPrompt or customPathPlaceholder in quickstart copy", async () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const context = createContext("quickstart");

      const result = await step.execute(context);
      const copy = result.data?.copy as Record<string, unknown>;

      expect(copy.customPathPrompt).toBeUndefined();
      expect(copy.customPathPlaceholder).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // execute — advanced mode
  // ---------------------------------------------------------------------------

  describe("execute in advanced mode", () => {
    it("returns completed status", async () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.status).toBe("completed");
    });

    it("returns the default workspace path for TUI to pre-fill", async () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const context = createContext("advanced");

      const result = await step.execute(context);

      expect(result.data?.workspacePath).toBe(DEFAULT_PATH);
    });

    it("includes full copy including customPathPrompt and customPathPlaceholder", async () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const copy = result.data?.copy as Record<string, string>;

      expect(typeof copy.headline).toBe("string");
      expect(typeof copy.description).toBe("string");
      expect(typeof copy.benefit).toBe("string");
      expect(typeof copy.defaultPathLabel).toBe("string");
      expect(typeof copy.customPathPrompt).toBe("string");
      expect(typeof copy.customPathPlaceholder).toBe("string");
    });

    it("copy strings are non-empty", async () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const copy = result.data?.copy as Record<string, string>;

      for (const value of Object.values(copy)) {
        expect(value.length).toBeGreaterThan(0);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // getCopy — personality awareness
  // ---------------------------------------------------------------------------

  describe("getCopy", () => {
    it("returns balanced copy by default", () => {
      const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH });
      const copy = step.getCopy();

      const expected = getWorkspaceCopy("balanced");
      expect(copy).toEqual(expected);
    });

    it("returns copy matching the preset provided at construction", () => {
      const presets: PersonalityPreset[] = ["balanced", "concise", "technical", "warm"];

      for (const preset of presets) {
        const step = new WorkspaceStep({ defaultPath: DEFAULT_PATH, personalityPreset: preset });
        const copy = step.getCopy();
        const expected = getWorkspaceCopy(preset);
        expect(copy).toEqual(expected);
      }
    });

    it("uses personality preset from collectedData when present", () => {
      const step = new WorkspaceStep({
        defaultPath: DEFAULT_PATH,
        personalityPreset: "balanced",
      });

      const context = createContext("advanced", {
        collectedData: { personalityPreset: "warm" },
      });

      const copy = step.getCopy(context);
      const expected = getWorkspaceCopy("warm");
      expect(copy).toEqual(expected);
    });

    it("falls back to construction-time preset when collectedData has invalid value", () => {
      const step = new WorkspaceStep({
        defaultPath: DEFAULT_PATH,
        personalityPreset: "concise",
      });

      const context = createContext("advanced", {
        collectedData: { personalityPreset: "not-a-preset" },
      });

      const copy = step.getCopy(context);
      const expected = getWorkspaceCopy("concise");
      expect(copy).toEqual(expected);
    });

    it("falls back to construction-time preset when collectedData has no personalityPreset", () => {
      const step = new WorkspaceStep({
        defaultPath: DEFAULT_PATH,
        personalityPreset: "technical",
      });

      const context = createContext("advanced", { collectedData: {} });

      const copy = step.getCopy(context);
      const expected = getWorkspaceCopy("technical");
      expect(copy).toEqual(expected);
    });
  });

  // ---------------------------------------------------------------------------
  // Personality-aware copy in execute results
  // ---------------------------------------------------------------------------

  describe("personality-aware copy in execute results", () => {
    it("quickstart result uses warm copy when preset is warm", async () => {
      const step = new WorkspaceStep({
        defaultPath: DEFAULT_PATH,
        personalityPreset: "warm",
      });
      const context = createContext("quickstart");

      const result = await step.execute(context);
      const copy = result.data?.copy as Record<string, string>;
      const expected = getWorkspaceCopy("warm");

      expect(copy.headline).toBe(expected.headline);
      expect(copy.description).toBe(expected.description);
    });

    it("advanced result uses technical copy when preset is technical", async () => {
      const step = new WorkspaceStep({
        defaultPath: DEFAULT_PATH,
        personalityPreset: "technical",
      });
      const context = createContext("advanced");

      const result = await step.execute(context);
      const copy = result.data?.copy as Record<string, string>;
      const expected = getWorkspaceCopy("technical");

      expect(copy.headline).toBe(expected.headline);
      expect(copy.customPathPrompt).toBe(expected.customPathPrompt);
    });

    it("collectedData personality preset overrides construction-time preset in execute", async () => {
      const step = new WorkspaceStep({
        defaultPath: DEFAULT_PATH,
        personalityPreset: "balanced",
      });
      const context = createContext("advanced", {
        collectedData: { personalityPreset: "concise" },
      });

      const result = await step.execute(context);
      const copy = result.data?.copy as Record<string, string>;
      const expected = getWorkspaceCopy("concise");

      expect(copy.headline).toBe(expected.headline);
    });
  });

  // ---------------------------------------------------------------------------
  // getWorkspaceCopy helper
  // ---------------------------------------------------------------------------

  describe("getWorkspaceCopy", () => {
    it("returns balanced copy when no preset is provided", () => {
      const copy = getWorkspaceCopy();
      const expected = getWorkspaceCopy("balanced");
      expect(copy).toEqual(expected);
    });

    it("returns distinct copy for each preset", () => {
      const presets: PersonalityPreset[] = ["balanced", "concise", "technical", "warm"];
      const headlines = presets.map((p) => getWorkspaceCopy(p).headline);
      const uniqueHeadlines = new Set(headlines);

      expect(uniqueHeadlines.size).toBe(presets.length);
    });

    it("returns balanced copy for custom preset", () => {
      const copy = getWorkspaceCopy("custom");
      const balanced = getWorkspaceCopy("balanced");
      expect(copy).toEqual(balanced);
    });
  });

  // ---------------------------------------------------------------------------
  // WORKSPACE_COPY_VARIANTS completeness
  // ---------------------------------------------------------------------------

  describe("WORKSPACE_COPY_VARIANTS", () => {
    const presets: PersonalityPreset[] = ["balanced", "concise", "technical", "warm", "custom"];

    it("has an entry for every personality preset", () => {
      for (const preset of presets) {
        expect(WORKSPACE_COPY_VARIANTS[preset]).toBeDefined();
      }
    });

    it("every variant has all required copy fields", () => {
      const requiredFields: Array<keyof typeof WORKSPACE_COPY_VARIANTS.balanced> = [
        "headline",
        "description",
        "benefit",
        "defaultPathLabel",
        "customPathPrompt",
        "customPathPlaceholder",
      ];

      for (const preset of presets) {
        const variant = WORKSPACE_COPY_VARIANTS[preset];
        for (const field of requiredFields) {
          expect(typeof variant[field]).toBe("string");
          expect(variant[field].length).toBeGreaterThan(0);
        }
      }
    });

    it("non-custom presets have distinct headlines", () => {
      const nonCustomPresets: PersonalityPreset[] = ["balanced", "concise", "technical", "warm"];
      const headlines = nonCustomPresets.map((p) => WORKSPACE_COPY_VARIANTS[p].headline);
      const uniqueHeadlines = new Set(headlines);

      expect(uniqueHeadlines.size).toBe(nonCustomPresets.length);
    });
  });
});
