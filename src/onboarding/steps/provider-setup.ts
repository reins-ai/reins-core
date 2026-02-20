import type { PersonalityPreset } from "../types";
import { getProviderSetupCopy } from "./copy";
import type { ProviderSetupCopy } from "./copy";
import type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

/**
 * Result of auto-detecting a provider from an API key prefix.
 * Returned by the detectProvider callback.
 */
export interface ProviderDetectionResult {
  /** Detected provider ID, or null if no prefix matched. */
  providerId: string | null;
}

/**
 * Display metadata for a provider shown during onboarding.
 * Keeps raw provider IDs out of the user-facing experience.
 */
export interface ProviderDisplayInfo {
  /** Internal provider identifier (e.g. "anthropic"). */
  id: string;
  /** Human-friendly provider name (e.g. "Anthropic (Claude)"). */
  name: string;
  /** Short description of what the provider offers. */
  description: string;
  /** Whether this provider is already configured. */
  configured: boolean;
}

/** Default provider IDs available for onboarding setup. */
const DEFAULT_AVAILABLE_PROVIDERS = [
  "anthropic",
  "openai",
  "google",
  "fireworks",
] as const;

/** Human-friendly provider display metadata. */
const PROVIDER_DISPLAY: Record<string, { name: string; description: string }> = {
  anthropic: {
    name: "Anthropic (Claude)",
    description: "Advanced reasoning and analysis",
  },
  openai: {
    name: "OpenAI (GPT)",
    description: "Versatile general-purpose assistant",
  },
  google: {
    name: "Google (Gemini)",
    description: "Multimodal understanding and search",
  },
  fireworks: {
    name: "Fireworks AI",
    description: "Fast open-source model hosting",
  },
};

export interface ProviderSetupStepOptions {
  /** Available provider IDs for setup. Defaults to anthropic, openai, google, fireworks. */
  availableProviders?: string[];
  /** Check if a provider is already configured. */
  isProviderConfigured?: (providerId: string) => Promise<boolean>;
  /**
   * Auto-detect provider from an API key prefix.
   * Returns the detected provider ID or null if unrecognized.
   * This callback is provided by the key-detect utility (Task 1.4).
   */
  detectProvider?: (key: string) => ProviderDetectionResult;
  /**
   * Validate an API key for a given provider.
   * Returns true if the key is valid, false otherwise.
   */
  validateKey?: (providerId: string, key: string) => Promise<boolean>;
}

/**
 * Provider API key setup onboarding step.
 *
 * Provides context for the TUI to render the provider setup UI.
 * Does NOT contain the actual BYOK flow — that lives in the TUI
 * (thin client boundary). This step provides data, copy, and
 * detection results for the UI to present the setup experience.
 *
 * In QuickStart mode: accepts a single key, auto-detects provider
 * from prefix, validates, and returns the result. Falls back to
 * manual selection if prefix is unrecognized.
 *
 * In Advanced mode: returns the full list of available providers
 * with display metadata for the TUI to render a selection UI.
 */
export class ProviderSetupStep implements OnboardingStepHandler {
  readonly step = "provider-keys" as const;
  readonly skippable = true;

  private readonly availableProviders: string[];
  private readonly isProviderConfigured: (providerId: string) => Promise<boolean>;
  private readonly detectProvider: (key: string) => ProviderDetectionResult;
  private readonly validateKey: (providerId: string, key: string) => Promise<boolean>;

  constructor(options?: ProviderSetupStepOptions) {
    this.availableProviders = options?.availableProviders ?? [...DEFAULT_AVAILABLE_PROVIDERS];
    this.isProviderConfigured = options?.isProviderConfigured ?? (() => Promise.resolve(false));
    this.detectProvider = options?.detectProvider ?? (() => ({ providerId: null }));
    this.validateKey = options?.validateKey ?? (() => Promise.resolve(true));
  }

  async execute(context: StepExecutionContext): Promise<StepResult> {
    const personality = this.resolvePersonality(context);
    const copy = getProviderSetupCopy(personality);

    if (context.mode === "quickstart") {
      return this.executeQuickstart(context, copy);
    }

    return this.executeAdvanced(context, copy);
  }

  getDefaults(): StepDefaults {
    return {
      provider: "anthropic",
      configured: false,
    };
  }

  /**
   * Quickstart mode: single key input → auto-detect → validate.
   *
   * If the user provided a key in collectedData, detect and validate it.
   * Otherwise, return prompts for the TUI to collect the key.
   */
  private async executeQuickstart(
    context: StepExecutionContext,
    copy: ProviderSetupCopy,
  ): Promise<StepResult> {
    const apiKey = typeof context.collectedData.apiKey === "string"
      ? context.collectedData.apiKey.trim()
      : undefined;

    // No key provided yet — return copy for TUI to prompt user
    if (!apiKey) {
      return {
        status: "completed",
        data: {
          flow: "quickstart-prompt",
          copy: {
            title: copy.title,
            prompt: copy.quickstartPrompt,
            hint: copy.quickstartHint,
            skipMessage: copy.skipMessage,
          },
          defaultProvider: "anthropic",
        },
      };
    }

    // Key provided — attempt auto-detection
    const detection = this.detectProvider(apiKey);

    if (detection.providerId) {
      const providerName = this.getProviderDisplayName(detection.providerId);
      const isValid = await this.validateKey(detection.providerId, apiKey);

      return {
        status: "completed",
        data: {
          flow: "quickstart-detected",
          detectedProvider: detection.providerId,
          providerName,
          keyValid: isValid,
          copy: {
            title: copy.title,
            detectedMessage: copy.detectedMessage(providerName),
            validatingMessage: copy.validatingMessage,
          },
        },
      };
    }

    // No prefix match — fall back to manual selection
    const providerList = await this.buildProviderList(this.availableProviders);

    return {
      status: "completed",
      data: {
        flow: "quickstart-fallback",
        providers: providerList,
        copy: {
          title: copy.title,
          fallbackMessage: copy.fallbackMessage,
        },
      },
    };
  }

  /**
   * Advanced mode: full provider list with manual selection.
   *
   * Returns all available providers with display metadata and
   * configuration status for the TUI to render a selection UI.
   */
  private async executeAdvanced(
    context: StepExecutionContext,
    copy: ProviderSetupCopy,
  ): Promise<StepResult> {
    const providerList = await this.buildProviderList(this.availableProviders);

    // If user already selected a provider and provided a key, validate it
    const selectedProvider = typeof context.collectedData.selectedProvider === "string"
      ? context.collectedData.selectedProvider
      : undefined;
    const apiKey = typeof context.collectedData.apiKey === "string"
      ? context.collectedData.apiKey.trim()
      : undefined;

    let keyValid: boolean | undefined;
    if (selectedProvider && apiKey) {
      keyValid = await this.validateKey(selectedProvider, apiKey);
    }

    return {
      status: "completed",
      data: {
        flow: "advanced",
        providers: providerList,
        selectedProvider,
        keyValid,
        copy: {
          title: copy.title,
          prompt: copy.advancedPrompt,
          validatingMessage: copy.validatingMessage,
          skipMessage: copy.skipMessage,
        },
      },
    };
  }

  /**
   * Build display info for a list of provider IDs,
   * including configuration status checks.
   */
  private async buildProviderList(providerIds: string[]): Promise<ProviderDisplayInfo[]> {
    return Promise.all(
      providerIds.map(async (id) => {
        const display = PROVIDER_DISPLAY[id];
        const configured = await this.isProviderConfigured(id);
        return {
          id,
          name: display?.name ?? id,
          description: display?.description ?? "",
          configured,
        };
      }),
    );
  }

  /** Get the human-friendly display name for a provider ID. */
  private getProviderDisplayName(providerId: string): string {
    return PROVIDER_DISPLAY[providerId]?.name ?? providerId;
  }

  /** Extract personality preset from collected data or config. */
  private resolvePersonality(context: StepExecutionContext): PersonalityPreset | undefined {
    const fromData = context.collectedData.preset ?? context.collectedData.personalityPreset;
    if (
      fromData === "balanced"
      || fromData === "concise"
      || fromData === "technical"
      || fromData === "warm"
      || fromData === "custom"
    ) {
      return fromData;
    }
    return context.config.personality?.preset;
  }
}
