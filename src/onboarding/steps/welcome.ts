import type { PersonalityPreset } from "../types";
import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";
import { getWelcomeCopy, type WelcomeCopy } from "./copy";

export interface WelcomeStepOptions {
  /** Override for testing — provides a user name without interactive input. */
  readUserName?: () => Promise<string | undefined>;
  /** Personality preset to select copy tone. Defaults to "balanced". */
  personalityPreset?: PersonalityPreset;
}

/**
 * First onboarding step: greets the user, captures their name, and
 * presents the QuickStart / Advanced mode choice.
 *
 * Quickstart mode prompts for the user's real name (single text field)
 * and auto-completes with sensible defaults for everything else.
 *
 * Advanced mode returns structured data for the TUI to render a full
 * name input and mode selection UI.
 *
 * Copy is personality-aware — the tone adjusts based on the selected
 * personality preset (balanced, concise, technical, warm).
 */
export class WelcomeStep implements OnboardingStepHandler {
  readonly step = "welcome" as const;
  readonly skippable = false;

  private readonly readUserName?: () => Promise<string | undefined>;
  private readonly personalityPreset: PersonalityPreset;

  constructor(options?: WelcomeStepOptions) {
    this.readUserName = options?.readUserName;
    this.personalityPreset = options?.personalityPreset ?? "balanced";
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    const copy = this.getCopy(context);

    if (context.mode === "quickstart") {
      return this.executeQuickstart(copy);
    }

    return this.executeAdvanced(copy);
  }

  getDefaults(): StepDefaults {
    return {
      userName: "User",
      selectedMode: "quickstart",
    };
  }

  /**
   * Get the personality-aware copy for this step.
   *
   * Checks the execution context's collected data for a personality
   * preset first (in case a previous step set it), then falls back
   * to the preset provided at construction time.
   */
  getCopy(context?: StepExecutionContext): WelcomeCopy {
    const contextPreset = context?.collectedData?.personalityPreset;
    const preset = isPersonalityPreset(contextPreset)
      ? contextPreset
      : this.personalityPreset;
    return getWelcomeCopy(preset);
  }

  private async executeQuickstart(copy: WelcomeCopy): Promise<StepResult> {
    const userName = this.readUserName
      ? await this.readUserName()
      : undefined;

    return {
      status: "completed",
      data: {
        userName: userName?.trim() || "User",
        selectedMode: "quickstart",
        copy: {
          headline: copy.headline,
          subtitle: copy.subtitle,
          namePrompt: copy.namePrompt,
          namePlaceholder: copy.namePlaceholder,
        },
      },
    };
  }

  private async executeAdvanced(copy: WelcomeCopy): Promise<StepResult> {
    const userName = this.readUserName
      ? await this.readUserName()
      : undefined;

    return {
      status: "completed",
      data: {
        userName: userName?.trim() || "User",
        selectedMode: "advanced",
        copy: {
          headline: copy.headline,
          subtitle: copy.subtitle,
          namePrompt: copy.namePrompt,
          namePlaceholder: copy.namePlaceholder,
          quickstartLabel: copy.quickstartLabel,
          quickstartDescription: copy.quickstartDescription,
          advancedLabel: copy.advancedLabel,
          advancedDescription: copy.advancedDescription,
        },
      },
    };
  }
}

function isPersonalityPreset(value: unknown): value is PersonalityPreset {
  return (
    value === "balanced"
    || value === "concise"
    || value === "technical"
    || value === "warm"
    || value === "custom"
  );
}
