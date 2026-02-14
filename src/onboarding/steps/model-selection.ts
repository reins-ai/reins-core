import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

export interface AvailableModel {
  id: string;
  name: string;
  provider: string;
}

export interface ModelSelectionStepOptions {
  /** Fetch available models from configured providers. */
  listModels?: () => Promise<AvailableModel[]>;
}

/**
 * Model selection onboarding step.
 *
 * Queries available models from providers configured in the
 * previous step and returns the selected default model.
 *
 * In QuickStart mode: auto-selects the first available model.
 * In Advanced mode: returns the full model list for user choice.
 * Skippable — the system can function without explicit model selection.
 */
export class ModelSelectionStep implements OnboardingStepHandler {
  readonly step = "model-select" as const;
  readonly skippable = true;

  private readonly listModels: () => Promise<AvailableModel[]>;

  constructor(options?: ModelSelectionStepOptions) {
    this.listModels = options?.listModels ?? (() => Promise.resolve([]));
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    const models = await this.listModels();

    if (models.length === 0) {
      return {
        status: "completed",
        data: {
          modelId: null,
          provider: null,
          autoSelected: true,
          availableModels: [],
        },
      };
    }

    if (context.mode === "quickstart") {
      const selected = models[0];
      return {
        status: "completed",
        data: {
          modelId: selected.id,
          provider: selected.provider,
          autoSelected: true,
          availableModels: models,
        },
      };
    }

    // Advanced mode: return full list for user to choose
    return {
      status: "completed",
      data: {
        modelId: null,
        provider: null,
        autoSelected: false,
        availableModels: models,
      },
    };
  }

  getDefaults(): StepDefaults {
    return {
      modelId: null,
      autoSelected: true,
    };
  }
}
