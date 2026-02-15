import { describe, expect, it } from "bun:test";

import type { OnboardingConfig, OnboardingMode } from "../../../src/onboarding/types";
import type { StepExecutionContext } from "../../../src/onboarding/steps/types";
import { WelcomeStep } from "../../../src/onboarding/steps/welcome";

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

  it("executes in quickstart mode with default values", async () => {
    const step = new WelcomeStep();
    const context = createContext("quickstart");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data).toEqual({
      userName: "User",
      selectedMode: "quickstart",
    });
  });

  it("executes in advanced mode with default name when no reader provided", async () => {
    const step = new WelcomeStep();
    const context = createContext("advanced");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data).toEqual({
      userName: "User",
      selectedMode: "advanced",
    });
  });

  it("executes in advanced mode with name from reader", async () => {
    const step = new WelcomeStep({
      readUserName: async () => "Alice",
    });
    const context = createContext("advanced");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data).toEqual({
      userName: "Alice",
      selectedMode: "advanced",
    });
  });

  it("falls back to default name when reader returns undefined", async () => {
    const step = new WelcomeStep({
      readUserName: async () => undefined,
    });
    const context = createContext("advanced");

    const result = await step.execute(context);

    expect(result.status).toBe("completed");
    expect(result.data?.userName).toBe("User");
  });
});
