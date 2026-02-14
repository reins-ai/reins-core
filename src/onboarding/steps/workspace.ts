import { homedir } from "node:os";
import { join } from "node:path";

import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

/**
 * Workspace setup onboarding step.
 *
 * Configures the workspace directory path. In QuickStart mode,
 * auto-selects the default path (~/<defaultDirName>). In Advanced mode,
 * returns the default for the TUI to present with an option to customize.
 */
export class WorkspaceStep implements OnboardingStepHandler {
  readonly step = "workspace" as const;
  readonly skippable = true;

  async execute(context: StepExecutionContext): Promise<StepResult> {
    if (context.mode === "quickstart") {
      return {
        status: "completed",
        data: { workspacePath: this.getDefaultPath() },
      };
    }

    // Advanced mode: provide default path for TUI to display with edit option
    return {
      status: "completed",
      data: { workspacePath: this.getDefaultPath() },
    };
  }

  getDefaults(): StepDefaults {
    return {
      workspacePath: this.getDefaultPath(),
    };
  }

  private getDefaultPath(): string {
    return join(homedir(), "reins-workspace");
  }
}
