import type { PersonalityPreset } from "../types";
import {
  PERSONALITY_PRESETS,
  type PersonalityPromptDefinition,
} from "../personality-prompts";
import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

export interface PersonalityStepOptions {
  /** Override presets for testing. */
  presets?: ReadonlyArray<PersonalityPromptDefinition>;
}

/**
 * Personality configuration onboarding step.
 *
 * Offers preset personalities (Balanced, Concise, Technical, Warm) and a
 * Custom option with free-text input. In QuickStart mode, auto-selects
 * "balanced". In Advanced mode, returns the available presets for the TUI
 * to render as a selection UI.
 */
export class PersonalityStep implements OnboardingStepHandler {
  readonly step = "personality" as const;
  readonly skippable = true;

  private readonly presets: ReadonlyArray<PersonalityPromptDefinition>;

  constructor(options?: PersonalityStepOptions) {
    this.presets = options?.presets ?? PERSONALITY_PRESETS;
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    if (context.mode === "quickstart") {
      const defaults = this.getDefaults();
      return {
        status: "completed",
        data: defaults,
      };
    }

    // Advanced mode: provide preset options for TUI to display
    return {
      status: "completed",
      data: {
        availablePresets: this.presets.map((p) => ({
          preset: p.preset,
          label: p.label,
          description: p.description,
        })),
        supportsCustom: true,
      },
    };
  }

  getDefaults(): StepDefaults {
    return {
      preset: "balanced" as PersonalityPreset,
      customPrompt: undefined,
    };
  }
}
