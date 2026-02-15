import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

/** Default provider IDs available for onboarding setup. */
const DEFAULT_AVAILABLE_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
] as const;

export interface ProviderSetupStepOptions {
  /** Available provider IDs for setup. Defaults to anthropic, openai, google. */
  availableProviders?: string[];
  /** Check if a provider is already configured. */
  isProviderConfigured?: (providerId: string) => Promise<boolean>;
}

/**
 * Provider API key setup onboarding step.
 *
 * Provides context for the TUI to render the provider setup UI.
 * Does NOT contain the actual BYOK flow — that lives in the TUI
 * (thin client boundary). This step lists available providers,
 * checks which are already configured, and returns the data
 * needed for the UI to present the setup experience.
 *
 * In QuickStart mode: returns a single default provider (anthropic).
 * In Advanced mode: returns the full list of available providers.
 */
export class ProviderSetupStep implements OnboardingStepHandler {
  readonly step = "provider-keys" as const;
  readonly skippable = true;

  private readonly availableProviders: string[];
  private readonly isProviderConfigured: (providerId: string) => Promise<boolean>;

  constructor(options?: ProviderSetupStepOptions) {
    this.availableProviders = options?.availableProviders ?? [...DEFAULT_AVAILABLE_PROVIDERS];
    this.isProviderConfigured = options?.isProviderConfigured ?? (() => Promise.resolve(false));
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    const providers = context.mode === "quickstart"
      ? this.availableProviders.slice(0, 1)
      : this.availableProviders;

    const configuredStatuses = await Promise.all(
      providers.map(async (providerId) => ({
        providerId,
        configured: await this.isProviderConfigured(providerId),
      })),
    );

    const configuredProviders = configuredStatuses
      .filter((entry) => entry.configured)
      .map((entry) => entry.providerId);

    return {
      status: "completed",
      data: {
        availableProviders: providers,
        configuredProviders,
        defaultProvider: providers[0] ?? "anthropic",
      },
    };
  }

  getDefaults(): StepDefaults {
    return {
      provider: "anthropic",
      configured: false,
    };
  }
}
