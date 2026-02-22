import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OnboardingCheckpointService,
  OnboardingError,
} from "../../src/onboarding/checkpoint-service";
import type { OnboardingConfig } from "../../src/onboarding/types";

const createdDirectories: string[] = [];

async function createTempDataRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-checkpoint-"));
  createdDirectories.push(directory);
  return directory;
}

describe("OnboardingCheckpointService", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  describe("load", () => {
    it("returns null when no checkpoint file exists", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const result = await service.load();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it("loads a valid checkpoint from disk", async () => {
      const dataRoot = await createTempDataRoot();
      const checkpoint: OnboardingConfig = {
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

      await writeFile(
        join(dataRoot, "onboarding.json"),
        JSON.stringify(checkpoint, null, 2),
        "utf8",
      );

      const service = new OnboardingCheckpointService({ dataRoot });
      const result = await service.load();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.mode).toBe("quickstart");
      expect(result.value!.currentStep).toBe("provider-keys");
      expect(result.value!.completedSteps).toHaveLength(2);
      expect(result.value!.completedSteps[0].step).toBe("welcome");
      expect(result.value!.completedSteps[1].step).toBe("daemon-install");
    });

    it("handles corrupt JSON gracefully by returning null", async () => {
      const dataRoot = await createTempDataRoot();
      await writeFile(
        join(dataRoot, "onboarding.json"),
        "not valid json{{{",
        "utf8",
      );

      const service = new OnboardingCheckpointService({ dataRoot });
      const result = await service.load();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it("normalizes invalid data to a fresh checkpoint", async () => {
      const dataRoot = await createTempDataRoot();
      await writeFile(
        join(dataRoot, "onboarding.json"),
        JSON.stringify({ setupComplete: "not-a-boolean", mode: "invalid" }),
        "utf8",
      );

      const service = new OnboardingCheckpointService({ dataRoot });
      const result = await service.load();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      expect(result.value!.setupComplete).toBe(false);
      expect(result.value!.mode).toBe("quickstart");
      expect(result.value!.completedSteps).toHaveLength(0);
    });

    it("filters out invalid completed step records", async () => {
      const dataRoot = await createTempDataRoot();
      await writeFile(
        join(dataRoot, "onboarding.json"),
        JSON.stringify({
          setupComplete: false,
          mode: "advanced",
          currentStep: null,
          completedSteps: [
            { step: "welcome", completedAt: "2026-02-14T10:00:00.000Z", mode: "quickstart" },
            { step: "invalid-step", completedAt: "2026-02-14T10:01:00.000Z", mode: "quickstart" },
            { step: "daemon-install", completedAt: "2026-02-14T10:02:00.000Z", mode: "quickstart" },
            "not-an-object",
            { step: "provider-keys" }, // missing completedAt and mode
            { step: "model-select", completedAt: "2026-02-14T10:03:00.000Z", mode: "invalid-mode" },
          ],
          startedAt: "2026-02-14T09:59:00.000Z",
          completedAt: null,
        }),
        "utf8",
      );

      const service = new OnboardingCheckpointService({ dataRoot });
      const result = await service.load();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).not.toBeNull();
      // Valid records: welcome and daemon-install (invalid-step rejected, provider-keys missing fields, model-select invalid mode)
      expect(result.value!.completedSteps).toHaveLength(2);
      expect(result.value!.completedSteps[0].step).toBe("welcome");
      expect(result.value!.completedSteps[1].step).toBe("daemon-install");
    });
  });

  describe("save", () => {
    it("saves checkpoint to disk and reads it back", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const checkpoint: OnboardingConfig = {
        setupComplete: false,
        mode: "advanced",
        currentStep: "welcome",
        completedSteps: [],
        startedAt: "2026-02-14T10:00:00.000Z",
        completedAt: null,
      };

      const saveResult = await service.save(checkpoint);
      expect(saveResult.ok).toBe(true);

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value).not.toBeNull();
      expect(loadResult.value!.mode).toBe("advanced");
      expect(loadResult.value!.currentStep).toBe("welcome");
    });

    it("creates parent directories if they do not exist", async () => {
      const dataRoot = join(
        await createTempDataRoot(),
        "nested",
        "deep",
      );
      const service = new OnboardingCheckpointService({ dataRoot });

      const checkpoint: OnboardingConfig = {
        setupComplete: false,
        mode: "quickstart",
        currentStep: "welcome",
        completedSteps: [],
        startedAt: "2026-02-14T10:00:00.000Z",
        completedAt: null,
      };

      const saveResult = await service.save(checkpoint);
      expect(saveResult.ok).toBe(true);

      const file = Bun.file(join(dataRoot, "onboarding.json"));
      expect(await file.exists()).toBe(true);
    });

    it("writes JSON with 2-space indentation and trailing newline", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const checkpoint: OnboardingConfig = {
        setupComplete: false,
        mode: "quickstart",
        currentStep: "welcome",
        completedSteps: [],
        startedAt: "2026-02-14T10:00:00.000Z",
        completedAt: null,
      };

      await service.save(checkpoint);

      const raw = await Bun.file(join(dataRoot, "onboarding.json")).text();
      expect(raw).toEndWith("\n");
      // 2-space indentation check
      expect(raw).toContain('  "setupComplete"');
    });
  });

  describe("completeStep", () => {
    it("adds a step to completedSteps array", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const result = await service.completeStep("welcome", "quickstart");
      expect(result.ok).toBe(true);

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value).not.toBeNull();
      expect(loadResult.value!.completedSteps).toHaveLength(1);
      expect(loadResult.value!.completedSteps[0].step).toBe("welcome");
      expect(loadResult.value!.completedSteps[0].mode).toBe("quickstart");
      expect(loadResult.value!.completedSteps[0].completedAt).toBeTruthy();
    });

    it("does not duplicate already completed steps", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      await service.completeStep("welcome", "quickstart");
      await service.completeStep("welcome", "quickstart");

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.completedSteps).toHaveLength(1);
    });

    it("advances currentStep to next incomplete step", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      await service.completeStep("welcome", "quickstart");

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.currentStep).toBe("daemon-install");
    });

    it("sets setupComplete when all steps are done", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const steps = [
        "welcome",
        "daemon-install",
        "provider-keys",
        "openclaw-migration",
        "model-select",
        "workspace",
        "personality",
        "feature-discovery",
      ] as const;

      for (const step of steps) {
        await service.completeStep(step, "advanced");
      }

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.setupComplete).toBe(true);
      expect(loadResult.value!.currentStep).toBeNull();
      expect(loadResult.value!.completedAt).toBeTruthy();
    });

    it("preserves mode from the completing step", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      await service.completeStep("welcome", "quickstart");
      await service.completeStep("daemon-install", "advanced");

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      // Mode reflects the last completeStep call
      expect(loadResult.value!.mode).toBe("advanced");
      // Each step record preserves its own mode
      expect(loadResult.value!.completedSteps[0].mode).toBe("quickstart");
      expect(loadResult.value!.completedSteps[1].mode).toBe("advanced");
    });
  });

  describe("isComplete", () => {
    it("returns false when no checkpoint exists", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const result = await service.isComplete();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(false);
    });

    it("returns false when onboarding is in progress", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      await service.completeStep("welcome", "quickstart");

      const result = await service.isComplete();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(false);
    });

    it("returns true when all steps are completed", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const steps = [
        "welcome",
        "daemon-install",
        "provider-keys",
        "openclaw-migration",
        "model-select",
        "workspace",
        "personality",
        "feature-discovery",
      ] as const;

      for (const step of steps) {
        await service.completeStep(step, "quickstart");
      }

      const result = await service.isComplete();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe(true);
    });
  });

  describe("getResumeStep", () => {
    it("returns null when no checkpoint exists", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const result = await service.getResumeStep();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it("returns the next incomplete step", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      await service.completeStep("welcome", "quickstart");
      await service.completeStep("daemon-install", "quickstart");

      const result = await service.getResumeStep();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBe("provider-keys");
    });

    it("returns null when onboarding is complete", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const steps = [
        "welcome",
        "daemon-install",
        "provider-keys",
        "openclaw-migration",
        "model-select",
        "workspace",
        "personality",
        "feature-discovery",
      ] as const;

      for (const step of steps) {
        await service.completeStep(step, "quickstart");
      }

      const result = await service.getResumeStep();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeNull();
    });

    it("handles non-sequential completion order", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      // Complete steps out of order
      await service.completeStep("welcome", "advanced");
      await service.completeStep("provider-keys", "advanced");

      const result = await service.getResumeStep();

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // Should return the first incomplete step in ONBOARDING_STEPS order
      expect(result.value).toBe("daemon-install");
    });
  });

  describe("reset", () => {
    it("removes the checkpoint file", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      await service.completeStep("welcome", "quickstart");

      const resetResult = await service.reset();
      expect(resetResult.ok).toBe(true);

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value).toBeNull();
    });

    it("succeeds when no checkpoint file exists", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const result = await service.reset();

      expect(result.ok).toBe(true);
    });

    it("allows starting fresh after reset", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      // Complete some steps
      await service.completeStep("welcome", "quickstart");
      await service.completeStep("daemon-install", "quickstart");

      // Reset
      await service.reset();

      // Start fresh
      await service.completeStep("welcome", "advanced");

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.completedSteps).toHaveLength(1);
      expect(loadResult.value!.completedSteps[0].mode).toBe("advanced");
    });
  });

  describe("persistence format", () => {
    it("persists startedAt timestamp on first step completion", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      await service.completeStep("welcome", "quickstart");

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.startedAt).toBeTruthy();
      // Should be a valid ISO timestamp
      expect(new Date(loadResult.value!.startedAt).toISOString()).toBe(
        loadResult.value!.startedAt,
      );
    });

    it("persists completedAt timestamp when all steps done", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      const steps = [
        "welcome",
        "daemon-install",
        "provider-keys",
        "openclaw-migration",
        "model-select",
        "workspace",
        "personality",
        "feature-discovery",
      ] as const;

      for (const step of steps) {
        await service.completeStep(step, "quickstart");
      }

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.completedAt).toBeTruthy();
      expect(new Date(loadResult.value!.completedAt!).toISOString()).toBe(
        loadResult.value!.completedAt,
      );
    });

    it("completedAt is null while onboarding is in progress", async () => {
      const dataRoot = await createTempDataRoot();
      const service = new OnboardingCheckpointService({ dataRoot });

      await service.completeStep("welcome", "quickstart");

      const loadResult = await service.load();
      expect(loadResult.ok).toBe(true);
      if (!loadResult.ok) return;
      expect(loadResult.value!.completedAt).toBeNull();
    });
  });
});
