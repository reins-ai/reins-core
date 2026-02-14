import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

export interface WelcomeStepOptions {
  /** Override for testing — provides a user name without interactive input. */
  readUserName?: () => Promise<string | undefined>;
}

/**
 * First onboarding step: captures user name and presents QuickStart/Advanced mode choice.
 *
 * In QuickStart mode, uses default values (name = "User", mode = "quickstart").
 * In Advanced mode, returns completed status with data for the TUI to populate.
 */
export class WelcomeStep implements OnboardingStepHandler {
  readonly step = "welcome" as const;
  readonly skippable = false;

  private readonly readUserName?: () => Promise<string | undefined>;

  constructor(options?: WelcomeStepOptions) {
    this.readUserName = options?.readUserName;
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    if (context.mode === "quickstart") {
      const defaults = this.getDefaults();
      return {
        status: "completed",
        data: defaults,
      };
    }

    // Advanced mode: attempt to read user name if a reader is provided
    const userName = this.readUserName
      ? await this.readUserName()
      : undefined;

    return {
      status: "completed",
      data: {
        userName: userName ?? "User",
        selectedMode: "advanced",
      },
    };
  }

  getDefaults(): StepDefaults {
    return {
      userName: "User",
      selectedMode: "quickstart",
    };
  }
}
