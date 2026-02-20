import { homedir } from "node:os";
import { join } from "node:path";

import type { PersonalityPreset } from "../types";
import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";
import { getWorkspaceCopy, type WorkspaceCopy } from "./copy";

export interface WorkspaceStepOptions {
  /** Personality preset to select copy tone. Defaults to "balanced". */
  personalityPreset?: PersonalityPreset;
  /** Override the default workspace path for testing. */
  defaultPath?: string;
}

/**
 * Workspace setup onboarding step.
 *
 * Explains what a workspace is (the folder where Reins stores notes,
 * HEARTBEAT.md, and other persistent files) and configures its path.
 *
 * In QuickStart mode the default path (`~/reins-workspace`) is returned
 * immediately — no user input required.
 *
 * In Advanced mode the step returns the default path together with
 * structured copy so the TUI can render a labelled input pre-filled
 * with the default, letting the user accept or change it.
 *
 * Copy is personality-aware — the tone adjusts based on the selected
 * personality preset (balanced, concise, technical, warm).
 */
export class WorkspaceStep implements OnboardingStepHandler {
  readonly step = "workspace" as const;
  readonly skippable = true;

  private readonly personalityPreset: PersonalityPreset;
  private readonly _defaultPath: string;

  constructor(options?: WorkspaceStepOptions) {
    this.personalityPreset = options?.personalityPreset ?? "balanced";
    this._defaultPath = options?.defaultPath ?? join(homedir(), "reins-workspace");
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    const copy = this.getCopy(context);

    if (context.mode === "quickstart") {
      return {
        status: "completed",
        data: {
          workspacePath: this._defaultPath,
          copy: {
            headline: copy.headline,
            description: copy.description,
            benefit: copy.benefit,
            defaultPathLabel: copy.defaultPathLabel,
          },
        },
      };
    }

    // Advanced mode: return default path + full copy so the TUI can render
    // a labelled, editable path input pre-filled with the default.
    return {
      status: "completed",
      data: {
        workspacePath: this._defaultPath,
        copy: {
          headline: copy.headline,
          description: copy.description,
          benefit: copy.benefit,
          defaultPathLabel: copy.defaultPathLabel,
          customPathPrompt: copy.customPathPrompt,
          customPathPlaceholder: copy.customPathPlaceholder,
        },
      },
    };
  }

  getDefaults(): StepDefaults {
    return {
      workspacePath: this._defaultPath,
    };
  }

  /**
   * Get the personality-aware copy for this step.
   *
   * Checks the execution context's collected data for a personality
   * preset first (in case a previous step set it), then falls back
   * to the preset provided at construction time.
   */
  getCopy(context?: StepExecutionContext): WorkspaceCopy {
    const contextPreset = context?.collectedData?.personalityPreset;
    const preset = isPersonalityPreset(contextPreset)
      ? contextPreset
      : this.personalityPreset;
    return getWorkspaceCopy(preset);
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
