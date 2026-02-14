import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OnboardingCheckpointService,
  OnboardingError,
} from "../../src/onboarding/checkpoint-service";
import {
  type OnboardingEngineOptions,
  type OnboardingEvent,
  OnboardingEngine,
  type OnboardingStepHandler,
} from "../../src/onboarding/engine";
import { ONBOARDING_STEPS, type OnboardingStep } from "../../src/onboarding/types";

const createdDirectories: string[] = [];

async function createTempDataRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-engine-"));
  createdDirectories.push(directory);
  return directory;
}

function createMockStepHandler(
  step: OnboardingStep,
  skippable = true,
): OnboardingStepHandler {
  return {
    step,
    skippable,
    async execute() {
      return { status: "completed", data: { mockData: true } };
    },
    getDefaults() {
      return { default: true };
    },
  };
}

function createEngineWithAllHandlers(
  checkpoint: OnboardingCheckpointService,
  onEvent?: (event: OnboardingEvent) => void,
): OnboardingEngine {
  const options: OnboardingEngineOptions = {
    checkpoint,
    steps: ONBOARDING_STEPS.map((step) => createMockStepHandler(step, true)),
    onEvent,
  };

  return new OnboardingEngine(options);
}

describe("OnboardingEngine", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("initializes with empty checkpoint and starts at first step", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const engine = createEngineWithAllHandlers(checkpoint);

    const result = await engine.initialize();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.currentStep).toBe("welcome");
    expect(result.value.currentStepIndex).toBe(0);
    expect(result.value.isComplete).toBe(false);
  });

  it("initializes with partial checkpoint and resumes at correct step", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    await checkpoint.completeStep("welcome", "advanced");
    await checkpoint.completeStep("daemon-install", "advanced");

    const engine = createEngineWithAllHandlers(checkpoint);
    const result = await engine.initialize();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe("advanced");
    expect(result.value.currentStep).toBe("provider-keys");
    expect(result.value.currentStepIndex).toBe(2);
    expect(result.value.completedSteps).toEqual(["welcome", "daemon-install"]);
  });

  it("next advances through steps in order", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const engine = createEngineWithAllHandlers(checkpoint);

    await engine.initialize();
    const nextResult = await engine.next();

    expect(nextResult.ok).toBe(true);
    if (!nextResult.ok) return;
    expect(nextResult.value.currentStep).toBe("daemon-install");
    expect(nextResult.value.currentStepIndex).toBe(1);
  });

  it("back moves to the previous step", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const engine = createEngineWithAllHandlers(checkpoint);

    await engine.initialize();
    await engine.next();
    const backResult = await engine.back();

    expect(backResult.ok).toBe(true);
    if (!backResult.ok) return;
    expect(backResult.value.currentStep).toBe("welcome");
    expect(backResult.value.currentStepIndex).toBe(0);
  });

  it("skip skips only skippable steps and returns error otherwise", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const events: OnboardingEvent[] = [];

    const engine = new OnboardingEngine({
      checkpoint,
      steps: [
        createMockStepHandler("welcome", false),
        ...ONBOARDING_STEPS
          .filter((step) => step !== "welcome")
          .map((step) => createMockStepHandler(step, true)),
      ],
      onEvent: (event) => events.push(event),
    });

    await engine.initialize();
    const nonSkippable = await engine.skip();

    expect(nonSkippable.ok).toBe(false);
    if (nonSkippable.ok) return;
    expect(nonSkippable.error).toBeInstanceOf(OnboardingError);
    expect(nonSkippable.error.code).toBe("STEP_NOT_SKIPPABLE");

    await engine.next();
    const skippable = await engine.skip();

    expect(skippable.ok).toBe(true);
    if (!skippable.ok) return;
    expect(skippable.value.skippedSteps).toEqual(["daemon-install"]);
    expect(events.some((event) => event.type === "stepSkip" && event.step === "daemon-install")).toBe(true);
  });

  it("completeCurrentStep saves checkpoint and emits completion event", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const events: OnboardingEvent[] = [];

    const engine = createEngineWithAllHandlers(checkpoint, (event) => events.push(event));
    await engine.initialize();

    const result = await engine.completeCurrentStep({ userName: "James" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const checkpointResult = await checkpoint.load();
    expect(checkpointResult.ok).toBe(true);
    if (!checkpointResult.ok) return;
    expect(checkpointResult.value).not.toBeNull();
    expect(checkpointResult.value!.completedSteps.map((step) => step.step)).toContain("welcome");
    expect(events.some((event) =>
      event.type === "stepComplete" && event.step === "welcome" && event.data?.userName === "James"
    )).toBe(true);
  });

  it("uses QuickStart defaults when completeCurrentStep is called without data", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const events: OnboardingEvent[] = [];
    const engine = createEngineWithAllHandlers(checkpoint, (event) => events.push(event));

    await engine.initialize();
    engine.setMode("quickstart");
    const result = await engine.completeCurrentStep();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(engine.getCollectedData()).toEqual({ default: true });

    const stepCompleteEvent = events.find((event) => event.type === "stepComplete");
    expect(stepCompleteEvent).toBeDefined();
    expect(stepCompleteEvent?.type).toBe("stepComplete");
    if (stepCompleteEvent?.type !== "stepComplete") return;
    expect(stepCompleteEvent.data).toEqual({ default: true });
  });

  it("marks onboarding complete and emits wizardComplete after final step", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const events: OnboardingEvent[] = [];
    const engine = createEngineWithAllHandlers(checkpoint, (event) => events.push(event));

    await engine.initialize();
    for (const _step of ONBOARDING_STEPS) {
      const result = await engine.completeCurrentStep({ done: true });
      expect(result.ok).toBe(true);
    }

    expect(engine.isComplete()).toBe(true);
    const wizardComplete = events.find((event) => event.type === "wizardComplete");
    expect(wizardComplete).toBeDefined();
    if (wizardComplete?.type !== "wizardComplete") return;
    expect(wizardComplete.config.setupComplete).toBe(true);
    expect(wizardComplete.config.currentStep).toBeNull();
  });

  it("registerStep adds handlers and throws on duplicate registration", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const engine = new OnboardingEngine({ checkpoint });

    engine.registerStep(createMockStepHandler("welcome"));

    expect(() => engine.registerStep(createMockStepHandler("welcome"))).toThrow(OnboardingError);
  });

  it("getState reflects current engine state", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const engine = createEngineWithAllHandlers(checkpoint);

    await engine.initialize();
    await engine.completeCurrentStep({ first: true });
    await engine.skip();

    const state = engine.getState();

    expect(state.currentStep).toBe("provider-keys");
    expect(state.currentStepIndex).toBe(2);
    expect(state.completedSteps).toEqual(["welcome"]);
    expect(state.skippedSteps).toEqual(["daemon-install"]);
    expect(state.totalSteps).toBe(ONBOARDING_STEPS.length);
  });

  it("emits events in expected order across lifecycle", async () => {
    const dataRoot = await createTempDataRoot();
    const checkpoint = new OnboardingCheckpointService({ dataRoot });
    const events: OnboardingEvent[] = [];

    const engine = createEngineWithAllHandlers(checkpoint, (event) => events.push(event));
    await engine.initialize();
    await engine.completeCurrentStep({ first: true });
    await engine.skip();

    const eventTypes = events.map((event) => event.type);
    expect(eventTypes).toEqual([
      "stepEnter",
      "stepComplete",
      "stepEnter",
      "stepSkip",
      "stepEnter",
    ]);
    expect(events[0]).toEqual({ type: "stepEnter", step: "welcome" });
    expect(events[1]).toEqual({ type: "stepComplete", step: "welcome", data: { first: true } });
    expect(events[2]).toEqual({ type: "stepEnter", step: "daemon-install" });
    expect(events[3]).toEqual({ type: "stepSkip", step: "daemon-install" });
    expect(events[4]).toEqual({ type: "stepEnter", step: "provider-keys" });
  });
});
