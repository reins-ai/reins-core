import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OnboardingCheckpointService,
} from "../../src/onboarding/checkpoint-service";
import {
  OnboardingEngine,
  type OnboardingEvent,
  type OnboardingStepHandler,
} from "../../src/onboarding/engine";
import {
  ONBOARDING_CHECKPOINT_VERSION,
  ONBOARDING_STEPS,
  type OnboardingStep,
} from "../../src/onboarding/types";

const createdDirectories: string[] = [];

async function createTempDataRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-resume-"));
  createdDirectories.push(directory);
  return directory;
}

/**
 * Creates a step handler that records execution calls for verification.
 * Each handler returns step-specific data to simulate real wizard answers.
 */
function createTrackingStepHandler(
  step: OnboardingStep,
  executionLog: OnboardingStep[],
  stepData?: Record<string, unknown>,
): OnboardingStepHandler {
  return {
    step,
    skippable: false,
    async execute() {
      executionLog.push(step);
      return { status: "completed", data: stepData ?? { [`${step}Done`]: true } };
    },
    getDefaults() {
      return stepData ?? { [`${step}Default`]: true };
    },
  };
}

function createAllTrackingHandlers(
  executionLog: OnboardingStep[],
  stepDataMap?: Partial<Record<OnboardingStep, Record<string, unknown>>>,
): OnboardingStepHandler[] {
  return ONBOARDING_STEPS.map((step) =>
    createTrackingStepHandler(step, executionLog, stepDataMap?.[step]),
  );
}

describe("Checkpoint Resume", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("resume at correct step after simulated restart", () => {
    it("resumes at step 3 after completing steps 1-2 and restarting", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete steps 1-2, then "kill" ---
      const session1Log: OnboardingStep[] = [];
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers(session1Log),
      });

      const initResult = await engine1.initialize();
      expect(initResult.ok).toBe(true);
      if (!initResult.ok) return;
      expect(initResult.value.currentStep).toBe("welcome");

      // Complete step 1 (welcome)
      const step1Result = await engine1.completeCurrentStep({ userName: "Alice" });
      expect(step1Result.ok).toBe(true);

      // Complete step 2 (daemon-install)
      const step2Result = await engine1.completeCurrentStep({ daemonPath: "/usr/local/bin" });
      expect(step2Result.ok).toBe(true);
      if (!step2Result.ok) return;
      expect(step2Result.value.currentStep).toBe("provider-keys");

      // Simulate kill — engine1 is discarded, no more calls

      // --- Session 2: New engine instance, same dataRoot ---
      const session2Log: OnboardingStep[] = [];
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createAllTrackingHandlers(session2Log),
      });

      const resumeResult = await engine2.initialize();
      expect(resumeResult.ok).toBe(true);
      if (!resumeResult.ok) return;

      // Should resume at step 3 (provider-keys), index 2
      expect(resumeResult.value.currentStep).toBe("provider-keys");
      expect(resumeResult.value.currentStepIndex).toBe(2);
      expect(resumeResult.value.completedSteps).toEqual(["welcome", "daemon-install"]);
      expect(resumeResult.value.isComplete).toBe(false);
    });

    it("resumes at step 5 after completing steps 1-4 and restarting", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete steps 1-4 ---
      const session1Log: OnboardingStep[] = [];
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers(session1Log),
      });

      await engine1.initialize();
      for (let i = 0; i < 4; i++) {
        const result = await engine1.completeCurrentStep({ step: i });
        expect(result.ok).toBe(true);
      }

      // Simulate kill

      // --- Session 2 ---
      const session2Log: OnboardingStep[] = [];
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createAllTrackingHandlers(session2Log),
      });

      const resumeResult = await engine2.initialize();
      expect(resumeResult.ok).toBe(true);
      if (!resumeResult.ok) return;

      // Should resume at step 5 (workspace), index 4
      expect(resumeResult.value.currentStep).toBe("workspace");
      expect(resumeResult.value.currentStepIndex).toBe(4);
      expect(resumeResult.value.completedSteps).toEqual([
        "welcome",
        "daemon-install",
        "provider-keys",
        "model-select",
      ]);
    });

    it("resumes at step 1 when killed before completing any step", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Initialize but don't complete anything ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers([]),
      });

      await engine1.initialize();
      // Simulate kill before completing any step — no checkpoint saved

      // --- Session 2 ---
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createAllTrackingHandlers([]),
      });

      const resumeResult = await engine2.initialize();
      expect(resumeResult.ok).toBe(true);
      if (!resumeResult.ok) return;

      // Should start from the beginning
      expect(resumeResult.value.currentStep).toBe("welcome");
      expect(resumeResult.value.currentStepIndex).toBe(0);
      expect(resumeResult.value.completedSteps).toEqual([]);
    });
  });

  describe("prior answers preserved across restart", () => {
    it("preserves userName collected during welcome step", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete welcome with userName ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers([], {
          welcome: { userName: "Alice" },
        }),
      });

      await engine1.initialize();
      await engine1.completeCurrentStep({ userName: "Alice" });

      // Simulate kill

      // --- Session 2: Verify userName persisted ---
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const loadResult = await checkpoint2.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      expect(loadResult.value).not.toBeNull();
      expect(loadResult.value!.userName).toBe("Alice");
    });

    it("preserves mode selection across restart", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Set advanced mode and complete a step ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers([]),
      });

      await engine1.initialize();
      engine1.setMode("advanced");
      await engine1.completeCurrentStep({ userName: "Bob" });

      // Simulate kill

      // --- Session 2: Verify mode preserved ---
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createAllTrackingHandlers([]),
      });

      const resumeResult = await engine2.initialize();
      expect(resumeResult.ok).toBe(true);
      if (!resumeResult.ok) return;

      expect(resumeResult.value.mode).toBe("advanced");
    });

    it("preserves personality config across restart", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete through personality step ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers([], {
          personality: { preset: "technical" },
        }),
      });

      await engine1.initialize();
      // Complete all steps up to and including personality
      for (const _step of ONBOARDING_STEPS) {
        const result = await engine1.completeCurrentStep();
        expect(result.ok).toBe(true);
      }

      // Simulate kill (wizard is complete at this point)

      // --- Session 2: Verify personality persisted ---
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const loadResult = await checkpoint2.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      expect(loadResult.value).not.toBeNull();
      expect(loadResult.value!.personality).toBeDefined();
      expect(loadResult.value!.personality!.preset).toBe("technical");
    });

    it("preserves completedSteps records with timestamps across restart", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete 2 steps ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers([]),
      });

      await engine1.initialize();
      await engine1.completeCurrentStep({ userName: "Charlie" });
      await engine1.completeCurrentStep({ daemonPath: "/opt/reins" });

      // Simulate kill

      // --- Session 2: Verify step records preserved ---
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const loadResult = await checkpoint2.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      const config = loadResult.value!;
      expect(config.completedSteps).toHaveLength(2);
      expect(config.completedSteps[0].step).toBe("welcome");
      expect(config.completedSteps[0].completedAt).toBeTruthy();
      expect(new Date(config.completedSteps[0].completedAt).toISOString()).toBe(
        config.completedSteps[0].completedAt,
      );
      expect(config.completedSteps[1].step).toBe("daemon-install");
      expect(config.completedSteps[1].completedAt).toBeTruthy();
    });

    it("preserves startedAt timestamp across restart", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1 ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers([]),
      });

      await engine1.initialize();
      await engine1.completeCurrentStep({ userName: "Dana" });

      // Capture startedAt from session 1
      const loadAfterSession1 = await checkpoint1.load();
      expect(loadAfterSession1.ok).toBe(true);
      if (!loadAfterSession1.ok) return;
      const session1StartedAt = loadAfterSession1.value!.startedAt;

      // Simulate kill

      // --- Session 2: Verify startedAt unchanged ---
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createAllTrackingHandlers([]),
      });

      await engine2.initialize();

      const loadAfterSession2 = await checkpoint2.load();
      expect(loadAfterSession2.ok).toBe(true);
      if (!loadAfterSession2.ok) return;

      // startedAt should be the same as session 1 — not reset on resume
      expect(loadAfterSession2.value!.startedAt).toBe(session1StartedAt);
    });
  });

  describe("completed steps not re-executed", () => {
    it("does not re-execute completed steps when resuming", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete steps 1-2 ---
      const session1Log: OnboardingStep[] = [];
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers(session1Log),
      });

      await engine1.initialize();
      await engine1.completeCurrentStep({ userName: "Eve" });
      await engine1.completeCurrentStep({ daemonPath: "/usr/bin" });

      expect(session1Log).toEqual(["welcome", "daemon-install"]);

      // Simulate kill

      // --- Session 2: Resume and complete remaining steps ---
      const session2Log: OnboardingStep[] = [];
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createAllTrackingHandlers(session2Log),
      });

      await engine2.initialize();

      // Complete remaining steps (3-7)
      for (let i = 0; i < 5; i++) {
        const result = await engine2.completeCurrentStep({ step: i + 3 });
        expect(result.ok).toBe(true);
      }

      // Session 2 should only have executed steps 3-7, NOT steps 1-2
      expect(session2Log).toEqual([
        "provider-keys",
        "model-select",
        "workspace",
        "personality",
        "feature-discovery",
      ]);

      expect(engine2.isComplete()).toBe(true);
    });

    it("emits stepEnter only for the resume step on initialization", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete steps 1-3 ---
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers([]),
      });

      await engine1.initialize();
      await engine1.completeCurrentStep();
      await engine1.completeCurrentStep();
      await engine1.completeCurrentStep();

      // Simulate kill

      // --- Session 2: Track events on resume ---
      const session2Events: OnboardingEvent[] = [];
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createAllTrackingHandlers([]),
        onEvent: (event) => session2Events.push(event),
      });

      await engine2.initialize();

      // Should emit exactly one stepEnter for the resume step
      expect(session2Events).toHaveLength(1);
      expect(session2Events[0].type).toBe("stepEnter");
      if (session2Events[0].type !== "stepEnter") return;
      expect(session2Events[0].step).toBe("model-select");
    });

    it("can complete the full wizard across two sessions", async () => {
      const dataRoot = await createTempDataRoot();

      // --- Session 1: Complete first 3 steps ---
      const session1Events: OnboardingEvent[] = [];
      const checkpoint1 = new OnboardingCheckpointService({ dataRoot });
      const engine1 = new OnboardingEngine({
        checkpoint: checkpoint1,
        steps: createAllTrackingHandlers([]),
        onEvent: (event) => session1Events.push(event),
      });

      await engine1.initialize();
      await engine1.completeCurrentStep({ userName: "Frank" });
      await engine1.completeCurrentStep();
      await engine1.completeCurrentStep();

      expect(engine1.isComplete()).toBe(false);

      // Simulate kill

      // --- Session 2: Complete remaining 4 steps ---
      const session2Events: OnboardingEvent[] = [];
      const checkpoint2 = new OnboardingCheckpointService({ dataRoot });
      const engine2 = new OnboardingEngine({
        checkpoint: checkpoint2,
        steps: createAllTrackingHandlers([]),
        onEvent: (event) => session2Events.push(event),
      });

      await engine2.initialize();
      await engine2.completeCurrentStep();
      await engine2.completeCurrentStep();
      await engine2.completeCurrentStep();
      await engine2.completeCurrentStep();

      expect(engine2.isComplete()).toBe(true);

      // Verify wizardComplete event fired in session 2
      const wizardComplete = session2Events.find((e) => e.type === "wizardComplete");
      expect(wizardComplete).toBeDefined();
      if (wizardComplete?.type !== "wizardComplete") return;
      expect(wizardComplete.config.setupComplete).toBe(true);
      expect(wizardComplete.config.userName).toBe("Frank");
    });
  });

  describe("checkpoint schema version", () => {
    it("persisted checkpoint includes version field", async () => {
      const dataRoot = await createTempDataRoot();
      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createAllTrackingHandlers([]),
      });

      await engine.initialize();
      await engine.completeCurrentStep({ userName: "Grace" });

      // Read raw JSON to verify version field is present
      const raw = await readFile(join(dataRoot, "onboarding.json"), "utf8");
      const parsed = JSON.parse(raw);

      expect(parsed.version).toBe(ONBOARDING_CHECKPOINT_VERSION);
      expect(typeof parsed.version).toBe("number");
    });

    it("version field matches ONBOARDING_CHECKPOINT_VERSION constant", async () => {
      const dataRoot = await createTempDataRoot();
      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createAllTrackingHandlers([]),
      });

      await engine.initialize();
      await engine.completeCurrentStep();

      const loadResult = await checkpoint.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      expect(loadResult.value!.version).toBe(ONBOARDING_CHECKPOINT_VERSION);
      expect(ONBOARDING_CHECKPOINT_VERSION).toBe(1);
    });

    it("loads checkpoint without version field and defaults to current version", async () => {
      const dataRoot = await createTempDataRoot();

      // Write a legacy checkpoint without version field
      const legacyCheckpoint = {
        setupComplete: false,
        mode: "quickstart",
        currentStep: "provider-keys",
        completedSteps: [
          { step: "welcome", completedAt: "2026-02-14T10:00:00.000Z", mode: "quickstart" },
          { step: "daemon-install", completedAt: "2026-02-14T10:01:00.000Z", mode: "quickstart" },
        ],
        startedAt: "2026-02-14T09:59:00.000Z",
        completedAt: null,
      };

      await Bun.write(
        join(dataRoot, "onboarding.json"),
        `${JSON.stringify(legacyCheckpoint, null, 2)}\n`,
      );

      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const loadResult = await checkpoint.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;

      // Should default to current version for migration safety
      expect(loadResult.value!.version).toBe(ONBOARDING_CHECKPOINT_VERSION);
      // Other fields should still be preserved
      expect(loadResult.value!.currentStep).toBe("provider-keys");
      expect(loadResult.value!.completedSteps).toHaveLength(2);
    });
  });

  describe("checkpoint file persistence", () => {
    it("checkpoint persists to onboarding.json in data root", async () => {
      const dataRoot = await createTempDataRoot();
      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createAllTrackingHandlers([]),
      });

      await engine.initialize();
      await engine.completeCurrentStep({ userName: "Heidi" });

      const file = Bun.file(join(dataRoot, "onboarding.json"));
      expect(await file.exists()).toBe(true);

      const content = await file.json();
      expect(content.userName).toBe("Heidi");
      expect(content.completedSteps).toHaveLength(1);
      expect(content.completedSteps[0].step).toBe("welcome");
    });

    it("checkpoint is updated after each step completion", async () => {
      const dataRoot = await createTempDataRoot();
      const checkpoint = new OnboardingCheckpointService({ dataRoot });
      const engine = new OnboardingEngine({
        checkpoint,
        steps: createAllTrackingHandlers([]),
      });

      await engine.initialize();

      // After step 1
      await engine.completeCurrentStep({ userName: "Ivan" });
      let content = await Bun.file(join(dataRoot, "onboarding.json")).json();
      expect(content.completedSteps).toHaveLength(1);
      expect(content.currentStep).toBe("daemon-install");

      // After step 2
      await engine.completeCurrentStep();
      content = await Bun.file(join(dataRoot, "onboarding.json")).json();
      expect(content.completedSteps).toHaveLength(2);
      expect(content.currentStep).toBe("provider-keys");

      // After step 3
      await engine.completeCurrentStep();
      content = await Bun.file(join(dataRoot, "onboarding.json")).json();
      expect(content.completedSteps).toHaveLength(3);
      expect(content.currentStep).toBe("model-select");
    });
  });
});
