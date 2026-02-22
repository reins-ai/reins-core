import { OpenClawDetector } from "../../conversion/detector";

import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

export interface OpenClawMigrationStepOptions {
  /** Injectable detector for testing. */
  detector?: OpenClawDetector;
}

/**
 * Onboarding step: OpenClaw migration.
 *
 * Runs OpenClaw detection. If no installation is found, auto-skips.
 * If found, returns detection data for the TUI to present the
 * migration UI. The TUI collects selectedCategories and reports
 * back via collectedData.
 */
export class OpenClawMigrationStep implements OnboardingStepHandler {
  readonly step = "openclaw-migration" as const;
  readonly skippable = true;

  private readonly detector: OpenClawDetector;

  constructor(options?: OpenClawMigrationStepOptions) {
    this.detector = options?.detector ?? new OpenClawDetector();
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    const detectionDone = context.collectedData.migrationDetectionDone === true;
    const skip = context.collectedData.migrationSkip === true;

    if (detectionDone && skip) {
      return { status: "skipped" };
    }

    if (detectionDone) {
      return {
        status: "completed",
        data: {
          migrationState: {
            detected: context.collectedData.migrationDetected === true,
            detectedPath: typeof context.collectedData.migrationPath === "string"
              ? context.collectedData.migrationPath
              : null,
            selectedCategories: Array.isArray(context.collectedData.migrationSelectedCategories)
              ? context.collectedData.migrationSelectedCategories.filter(
                (category): category is string => typeof category === "string",
              )
              : [],
            conversionStarted: context.collectedData.migrationConversionStarted === true,
            conversionComplete: context.collectedData.migrationConversionComplete === true,
          },
        },
      };
    }

    const result = await this.detector.detect();

    if (!result.found) {
      return { status: "skipped" };
    }

    return {
      status: "completed",
      data: {
        migrationDetectionDone: true,
        migrationDetected: true,
        migrationPath: result.path,
        migrationVersion: result.version,
        migrationPlatform: result.platform,
        migrationState: {
          detected: true,
          detectedPath: result.path,
          selectedCategories: [],
          conversionStarted: false,
          conversionComplete: false,
        },
      },
    };
  }

  getDefaults(): StepDefaults {
    return {
      migrationDetectionDone: true,
      migrationSkip: true,
    };
  }
}
