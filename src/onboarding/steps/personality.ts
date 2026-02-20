import type { PersonalityPreset } from "../types";
import {
  PERSONALITY_CARDS,
  type PersonalityCardData,
} from "../personality-prompts";
import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

export interface PersonalityStepOptions {
  /** Override cards for testing. */
  cards?: ReadonlyArray<PersonalityCardData>;
}

/**
 * Personality configuration onboarding step.
 *
 * Offers preset personalities (Balanced, Concise, Technical, Warm) and a
 * Custom option with free-text input. In QuickStart mode, auto-selects
 * "balanced". In Advanced mode, returns rich card data for each preset
 * so the TUI can render visual personality cards with emoji, description,
 * and example responses.
 */
export class PersonalityStep implements OnboardingStepHandler {
  readonly step = "personality" as const;
  readonly skippable = true;

  private readonly cards: ReadonlyArray<PersonalityCardData>;

  constructor(options?: PersonalityStepOptions) {
    this.cards = options?.cards ?? PERSONALITY_CARDS;
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    if (context.mode === "quickstart") {
      return {
        status: "completed",
        data: this.getDefaults(),
      };
    }

    // Advanced mode: provide rich card data for TUI to render as selectable cards
    return {
      status: "completed",
      data: {
        cards: this.cards.map((c) => ({
          preset: c.preset,
          label: c.label,
          emoji: c.emoji,
          description: c.description,
          exampleResponse: c.exampleResponse,
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
