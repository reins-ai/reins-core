import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

/**
 * Feature discovery onboarding step.
 *
 * Final step in the onboarding wizard that introduces key Reins
 * capabilities before the user enters the chat. Shows slash commands,
 * keyboard shortcuts, built-in tools, and provider information.
 *
 * This step always completes immediately — it is purely informational
 * and requires no user configuration. Both QuickStart and Advanced
 * modes behave identically.
 */
export class FeatureDiscoveryStep implements OnboardingStepHandler {
  readonly step = "feature-discovery" as const;
  readonly skippable = true;

  async execute(_context: StepExecutionContext): Promise<StepResult> {
    return {
      status: "completed",
      data: this.getDefaults(),
    };
  }

  getDefaults(): StepDefaults {
    return {
      featureDiscoveryViewed: true,
    };
  }
}
