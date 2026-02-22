import { describe, expect, it } from "bun:test";

import type { OpenClawDetector } from "../../src/conversion/detector";
import type { DetectionResult } from "../../src/conversion/types";
import type { StepExecutionContext } from "../../src/onboarding/engine";
import { OpenClawMigrationStep } from "../../src/onboarding/steps/openclaw-migration";

function mockDetector(result: DetectionResult): OpenClawDetector {
  return {
    detect: () => Promise.resolve(result),
  } as unknown as OpenClawDetector;
}

function createContext(collectedData: Record<string, unknown> = {}): StepExecutionContext {
  return {
    mode: "advanced",
    config: {
      version: 1,
      setupComplete: false,
      mode: "advanced",
      currentStep: "openclaw-migration",
      completedSteps: [],
      startedAt: new Date().toISOString(),
      completedAt: null,
    },
    collectedData,
  };
}

describe("OpenClawMigrationStep", () => {
  it("auto-skips when OpenClaw is not detected", async () => {
    const step = new OpenClawMigrationStep({
      detector: mockDetector({
        found: false,
        path: "",
        platform: "linux",
      }),
    });

    const result = await step.execute(createContext());

    expect(result).toEqual({ status: "skipped" });
  });

  it("returns detection data when OpenClaw is found", async () => {
    const step = new OpenClawMigrationStep({
      detector: mockDetector({
        found: true,
        path: "/home/user/.openclaw",
        platform: "linux",
        version: "2026.2.3-1",
      }),
    });

    const result = await step.execute(createContext());

    expect(result.status).toBe("completed");
    expect(result.data).toEqual({
      migrationDetectionDone: true,
      migrationDetected: true,
      migrationPath: "/home/user/.openclaw",
      migrationVersion: "2026.2.3-1",
      migrationPlatform: "linux",
      migrationState: {
        detected: true,
        detectedPath: "/home/user/.openclaw",
        selectedCategories: [],
        conversionStarted: false,
        conversionComplete: false,
      },
    });
  });

  it("uses the injected detector instance", async () => {
    let detectCalls = 0;
    const detector = {
      detect: async (): Promise<DetectionResult> => {
        detectCalls += 1;
        return {
          found: false,
          path: "",
          platform: "linux",
        };
      },
    } as unknown as OpenClawDetector;
    const step = new OpenClawMigrationStep({ detector });

    await step.execute(createContext());

    expect(detectCalls).toBe(1);
  });

  it("returns QuickStart defaults", () => {
    const step = new OpenClawMigrationStep();

    expect(step.getDefaults()).toEqual({
      migrationDetectionDone: true,
      migrationSkip: true,
    });
  });

  it("uses expected step identifier and skippable metadata", () => {
    const step = new OpenClawMigrationStep();

    expect(step.step).toBe("openclaw-migration");
    expect(step.skippable).toBe(true);
  });

  it("skips when detection was already done and user chose to skip", async () => {
    const step = new OpenClawMigrationStep({
      detector: mockDetector({
        found: true,
        path: "/ignored",
        platform: "linux",
      }),
    });

    const result = await step.execute(createContext({
      migrationDetectionDone: true,
      migrationSkip: true,
    }));

    expect(result).toEqual({ status: "skipped" });
  });

  it("returns migration state when detection was already done and not skipped", async () => {
    const step = new OpenClawMigrationStep({
      detector: mockDetector({
        found: false,
        path: "",
        platform: "linux",
      }),
    });

    const result = await step.execute(createContext({
      migrationDetectionDone: true,
      migrationSkip: false,
      migrationDetected: true,
      migrationPath: "/home/user/.openclaw",
      migrationSelectedCategories: ["agents", "skills"],
      migrationConversionStarted: true,
      migrationConversionComplete: false,
    }));

    expect(result).toEqual({
      status: "completed",
      data: {
        migrationState: {
          detected: true,
          detectedPath: "/home/user/.openclaw",
          selectedCategories: ["agents", "skills"],
          conversionStarted: true,
          conversionComplete: false,
        },
      },
    });
  });
});
