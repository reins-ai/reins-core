import type { PersonalityPreset } from "../types";
import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";
import {
  getFriendlyModelName,
  getModelSelectionCopy,
  type ModelSelectionCopy,
} from "./copy";

export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
}

/**
 * A model with its human-friendly display name resolved.
 *
 * Used in step results so the TUI never needs to display raw model IDs.
 */
export interface DisplayModel {
  /** Raw model identifier (for API calls). */
  id: string;
  /** Human-friendly display name (e.g. "Claude Sonnet 4" instead of "claude-sonnet-4-20250514"). */
  displayName: string;
  /** Provider identifier. */
  provider: string;
}

export interface ModelSelectionStepOptions {
  /** Fetch available models from configured providers. */
  listModels?: () => Promise<AvailableModel[]>;
  /** Personality preset to select copy tone. Defaults to "balanced". */
  personalityPreset?: PersonalityPreset;
}

/**
 * Model selection onboarding step.
 *
 * Queries available models from providers configured in the previous step
 * and presents them with human-friendly display names (not raw API IDs).
 *
 * In quickstart mode: auto-selects the first available model and returns
 * its friendly name. No raw model IDs are visible to the user.
 *
 * In advanced mode: returns the full model list with friendly names for
 * the TUI to render as a selection UI.
 *
 * Copy is personality-aware — the tone adjusts based on the selected
 * personality preset (balanced, concise, technical, warm).
 *
 * Skippable — the system can function without explicit model selection.
 */
export class ModelSelectionStep implements OnboardingStepHandler {
  readonly step = "model-select" as const;
  readonly skippable = true;

  private readonly listModels: () => Promise<AvailableModel[]>;
  private readonly personalityPreset: PersonalityPreset;

  constructor(options?: ModelSelectionStepOptions) {
    this.listModels = options?.listModels ?? (() => Promise.resolve([]));
    this.personalityPreset = options?.personalityPreset ?? "balanced";
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    const copy = this.getCopy(context);
    const models = await this.listModels();
    const displayModels = models.map(toDisplayModel);

    if (displayModels.length === 0) {
      return {
        status: "completed",
        data: {
          modelId: null,
          displayName: null,
          provider: null,
          autoSelected: true,
          availableModels: displayModels,
          copy: {
            headline: copy.headline,
            description: copy.description,
            statusMessage: copy.noModelsMessage,
          },
        },
      };
    }

    if (context.mode === "quickstart") {
      const selected = displayModels[0];
      return {
        status: "completed",
        data: {
          modelId: selected.id,
          displayName: selected.displayName,
          provider: selected.provider,
          autoSelected: true,
          availableModels: displayModels,
          copy: {
            headline: copy.headline,
            description: copy.description,
            statusMessage: copy.autoSelectedMessage,
          },
        },
      };
    }

    // Advanced mode: return full list with friendly names for user to choose
    return {
      status: "completed",
      data: {
        modelId: null,
        displayName: null,
        provider: null,
        autoSelected: false,
        availableModels: displayModels,
        copy: {
          headline: copy.headline,
          description: copy.description,
          selectionPrompt: copy.selectionPrompt,
        },
      },
    };
  }

  getDefaults(): StepDefaults {
    return {
      modelId: null,
      displayName: null,
      autoSelected: true,
    };
  }

  /**
   * Get the personality-aware copy for this step.
   *
   * Checks the execution context's collected data for a personality
   * preset first (in case a previous step set it), then falls back
   * to the preset provided at construction time.
   */
  getCopy(context?: StepExecutionContext): ModelSelectionCopy {
    const contextPreset = context?.collectedData?.personalityPreset;
    const preset = isPersonalityPreset(contextPreset)
      ? contextPreset
      : this.personalityPreset;
    return getModelSelectionCopy(preset);
  }
}

/**
 * Convert an AvailableModel to a DisplayModel with a friendly name.
 */
function toDisplayModel(model: AvailableModel): DisplayModel {
  return {
    id: model.id,
    displayName: getFriendlyModelName(model.id),
    provider: model.provider,
  };
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
