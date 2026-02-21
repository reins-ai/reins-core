import { describe, expect, it } from "bun:test";

import { ok, err } from "../../src/result";
import {
  FirstRunDetector,
  type FirstRunDetectorOptions,
} from "../../src/onboarding/first-run-detector";
import { OnboardingError } from "../../src/onboarding/checkpoint-service";
import type { OnboardingConfig, OnboardingStep } from "../../src/onboarding/types";

function createMockCheckpointService(config: OnboardingConfig | null) {
  return {
    load: async () => ok(config),
    save: async () => ok(undefined),
    completeStep: async () => ok(undefined),
    isComplete: async () => ok(config?.setupComplete ?? false),
    getResumeStep: async () => ok(null as OnboardingStep | null),
    reset: async () => ok(undefined),
  } as unknown as FirstRunDetectorOptions["checkpoint"];
}

function createMockConfigReader(config: { setupComplete: boolean } | null) {
  return async () => ok(config);
}

function createErrorConfigReader() {
  return async () => err(new Error("disk read failed"));
}

function createCheckpointWithSteps(
  steps: OnboardingStep[],
): OnboardingConfig {
  return {
    setupComplete: false,
    mode: "quickstart",
    currentStep: null,
    completedSteps: steps.map((step) => ({
      step,
      completedAt: "2026-02-14T10:00:00.000Z",
      mode: "quickstart" as const,
    })),
    startedAt: "2026-02-14T09:59:00.000Z",
    completedAt: null,
  };
}

describe("FirstRunDetector", () => {
  describe("detect", () => {
    it("returns first-run when no user config exists", async () => {
      const detector = new FirstRunDetector({
        checkpoint: createMockCheckpointService(null),
        readUserConfig: createMockConfigReader(null),
      });

      const result = await detector.detect();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("first-run");
      expect(result.value.resumeStep).toBeUndefined();
    });

    it("returns complete when user config has setupComplete=true", async () => {
      const detector = new FirstRunDetector({
        checkpoint: createMockCheckpointService(null),
        readUserConfig: createMockConfigReader({ setupComplete: true }),
      });

      const result = await detector.detect();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("complete");
      expect(result.value.resumeStep).toBeUndefined();
    });

    it("returns first-run when config exists with setupComplete=false and no checkpoint", async () => {
      const detector = new FirstRunDetector({
        checkpoint: createMockCheckpointService(null),
        readUserConfig: createMockConfigReader({ setupComplete: false }),
      });

      const result = await detector.detect();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("first-run");
      expect(result.value.resumeStep).toBeUndefined();
    });

    it("returns first-run when config exists with setupComplete=false and empty checkpoint", async () => {
      const checkpoint = createCheckpointWithSteps([]);
      const detector = new FirstRunDetector({
        checkpoint: createMockCheckpointService(checkpoint),
        readUserConfig: createMockConfigReader({ setupComplete: false }),
      });

      const result = await detector.detect();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("first-run");
      expect(result.value.resumeStep).toBeUndefined();
    });

    it("returns resume with correct resumeStep when partial checkpoint exists", async () => {
      const checkpoint = createCheckpointWithSteps([
        "welcome",
        "daemon-install",
      ]);
      const detector = new FirstRunDetector({
        checkpoint: createMockCheckpointService(checkpoint),
        readUserConfig: createMockConfigReader({ setupComplete: false }),
      });

      const result = await detector.detect();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("resume");
      expect(result.value.resumeStep).toBe("provider-keys");
    });

    it("returns resume from the first incomplete step regardless of completion order", async () => {
      const checkpoint = createCheckpointWithSteps([
        "welcome",
        "provider-keys",
        "personality",
      ]);
      const detector = new FirstRunDetector({
        checkpoint: createMockCheckpointService(checkpoint),
        readUserConfig: createMockConfigReader({ setupComplete: false }),
      });

      const result = await detector.detect();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("resume");
      expect(result.value.resumeStep).toBe("daemon-install");
    });

    it("returns complete when all steps are in checkpoint but setupComplete is false", async () => {
      const checkpoint = createCheckpointWithSteps([
        "welcome",
        "daemon-install",
        "provider-keys",
        "model-select",
        "workspace",
        "personality",
        "feature-discovery",
      ]);
      const detector = new FirstRunDetector({
        checkpoint: createMockCheckpointService(checkpoint),
        readUserConfig: createMockConfigReader({ setupComplete: false }),
      });

      const result = await detector.detect();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("complete");
      expect(result.value.resumeStep).toBeUndefined();
    });

    it("falls back to first-run when config read fails", async () => {
      const detector = new FirstRunDetector({
        checkpoint: createMockCheckpointService(null),
        readUserConfig: createErrorConfigReader(),
      });

      const result = await detector.detect();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.status).toBe("first-run");
    });

    it("propagates checkpoint load errors", async () => {
      const failingCheckpoint = {
        load: async () =>
          err(new OnboardingError("disk failure", "CHECKPOINT_READ_FAILED")),
        save: async () => ok(undefined),
        completeStep: async () => ok(undefined),
        isComplete: async () => ok(false),
        getResumeStep: async () => ok(null as OnboardingStep | null),
        reset: async () => ok(undefined),
      } as unknown as FirstRunDetectorOptions["checkpoint"];

      const detector = new FirstRunDetector({
        checkpoint: failingCheckpoint,
        readUserConfig: createMockConfigReader({ setupComplete: false }),
      });

      const result = await detector.detect();

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(OnboardingError);
      expect(result.error.code).toBe("CHECKPOINT_READ_FAILED");
    });

    it("does not load checkpoint when config is null", async () => {
      let checkpointLoadCalled = false;
      const trackingCheckpoint = {
        load: async () => {
          checkpointLoadCalled = true;
          return ok(null);
        },
        save: async () => ok(undefined),
        completeStep: async () => ok(undefined),
        isComplete: async () => ok(false),
        getResumeStep: async () => ok(null as OnboardingStep | null),
        reset: async () => ok(undefined),
      } as unknown as FirstRunDetectorOptions["checkpoint"];

      const detector = new FirstRunDetector({
        checkpoint: trackingCheckpoint,
        readUserConfig: createMockConfigReader(null),
      });

      await detector.detect();

      expect(checkpointLoadCalled).toBe(false);
    });

    it("does not load checkpoint when setupComplete is true", async () => {
      let checkpointLoadCalled = false;
      const trackingCheckpoint = {
        load: async () => {
          checkpointLoadCalled = true;
          return ok(null);
        },
        save: async () => ok(undefined),
        completeStep: async () => ok(undefined),
        isComplete: async () => ok(true),
        getResumeStep: async () => ok(null as OnboardingStep | null),
        reset: async () => ok(undefined),
      } as unknown as FirstRunDetectorOptions["checkpoint"];

      const detector = new FirstRunDetector({
        checkpoint: trackingCheckpoint,
        readUserConfig: createMockConfigReader({ setupComplete: true }),
      });

      await detector.detect();

      expect(checkpointLoadCalled).toBe(false);
    });
  });
});
