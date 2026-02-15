import { ok, err, type Result } from "../result";
import { readUserConfig } from "../config/user-config";

import type { OnboardingCheckpointService } from "./checkpoint-service";
import { OnboardingError } from "./checkpoint-service";
import { ONBOARDING_STEPS, type OnboardingStep } from "./types";

/**
 * Detection outcome for the app entry point.
 *
 * - `first-run`: No prior setup — launch the onboarding wizard from the beginning.
 * - `resume`: Partial onboarding exists — offer to continue from the last checkpoint.
 * - `complete`: Setup is finished — proceed directly to chat.
 */
export type FirstRunStatus = "first-run" | "resume" | "complete";

/**
 * Result of first-run detection, consumed by the app entry point
 * to decide whether to show the onboarding wizard, a resume prompt,
 * or the normal chat interface.
 */
export interface FirstRunDetectionResult {
  /** What state the app should be in. */
  status: FirstRunStatus;
  /** If resuming, which step to resume from. */
  resumeStep?: OnboardingStep;
}

export interface FirstRunDetectorOptions {
  checkpoint: OnboardingCheckpointService;
  /** Override for testing — reads user config setupComplete flag. */
  readUserConfig?: () => Promise<Result<{ setupComplete: boolean } | null, unknown>>;
}

/**
 * Determines whether onboarding should launch by inspecting user config
 * existence, the `setupComplete` flag, and checkpoint state.
 */
export class FirstRunDetector {
  private readonly checkpoint: OnboardingCheckpointService;
  private readonly configReader: () => Promise<Result<{ setupComplete: boolean } | null, unknown>>;

  constructor(options: FirstRunDetectorOptions) {
    this.checkpoint = options.checkpoint;
    this.configReader = options.readUserConfig ?? readUserConfig;
  }

  /**
   * Detect whether onboarding is needed, resumable, or complete.
   *
   * Decision logic:
   * 1. No user config → first-run
   * 2. Config exists, setupComplete=true → complete
   * 3. Config exists, setupComplete=false → check checkpoint:
   *    - Checkpoint with completed steps → resume (with next step)
   *    - No checkpoint or empty → first-run
   */
  async detect(): Promise<Result<FirstRunDetectionResult, OnboardingError>> {
    const configResult = await this.configReader();

    if (!configResult.ok) {
      // Config read failed — safest to treat as first-run so the user
      // can still get into the app and set things up.
      return ok({ status: "first-run" });
    }

    const config = configResult.value;

    // No config file at all → first run
    if (config === null) {
      return ok({ status: "first-run" });
    }

    // Config exists and setup is marked complete
    if (config.setupComplete) {
      return ok({ status: "complete" });
    }

    // Config exists but setup is incomplete — check checkpoint for resume state
    const checkpointResult = await this.checkpoint.load();

    if (!checkpointResult.ok) {
      return err(checkpointResult.error);
    }

    const checkpoint = checkpointResult.value;

    // No checkpoint or no completed steps → treat as first-run
    if (checkpoint === null || checkpoint.completedSteps.length === 0) {
      return ok({ status: "first-run" });
    }

    // Checkpoint has progress — check if all steps are actually complete
    const completedSet = new Set(checkpoint.completedSteps.map((r) => r.step));
    const allComplete = ONBOARDING_STEPS.every((s) => completedSet.has(s));

    if (allComplete) {
      return ok({ status: "complete" });
    }

    // Find the next incomplete step in order
    const resumeStep = ONBOARDING_STEPS.find((s) => !completedSet.has(s));

    return ok({
      status: "resume",
      resumeStep,
    });
  }
}
