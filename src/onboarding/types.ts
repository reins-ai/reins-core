/**
 * Onboarding wizard types and configuration schema.
 *
 * Defines the type system for the first-run onboarding experience:
 * step definitions, wizard modes, step status tracking, personality
 * configuration, and the onboarding config schema.
 */

/**
 * Ordered list of onboarding steps in sequence.
 */
export const ONBOARDING_STEPS = [
  "welcome",
  "daemon-install",
  "provider-keys",
  "model-select",
  "workspace",
  "personality",
] as const;

/**
 * Individual onboarding step identifier.
 */
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];

/**
 * Wizard execution mode.
 *
 * - `quickstart`: Sensible defaults, minimal prompts, fastest path to working setup
 * - `advanced`: Granular control per step, all options exposed
 */
export type OnboardingMode = "quickstart" | "advanced";

/**
 * Step completion status.
 *
 * - `pending`: Not yet started
 * - `active`: Currently in progress
 * - `completed`: Successfully finished
 * - `skipped`: User chose to skip (only allowed for non-critical steps)
 */
export type OnboardingStepStatus = "pending" | "active" | "completed" | "skipped";

/**
 * Personality preset options for bot behavior.
 *
 * - `balanced`: Neutral, professional tone (default)
 * - `concise`: Brief, to-the-point responses
 * - `technical`: Detailed, technical explanations
 * - `warm`: Friendly, conversational tone
 * - `custom`: User-defined system prompt modifier
 */
export type PersonalityPreset = "balanced" | "concise" | "technical" | "warm" | "custom";

/**
 * Bot personality configuration.
 */
export interface PersonalityConfig {
  /**
   * Selected personality preset.
   */
  preset: PersonalityPreset;

  /**
   * Custom system prompt modifier (only used when preset is "custom").
   */
  customPrompt?: string;
}

/**
 * Record of a completed onboarding step.
 */
export interface CompletedStepRecord {
  /**
   * Step identifier.
   */
  step: OnboardingStep;

  /**
   * ISO 8601 timestamp of completion.
   */
  completedAt: string;

  /**
   * Mode used when completing this step.
   */
  mode: OnboardingMode;
}

/**
 * Onboarding configuration schema.
 *
 * Persisted to `~/.reins/onboarding.json` for checkpoint/resume support.
 */
export interface OnboardingConfig {
  /**
   * Whether the full onboarding flow has been completed.
   */
  setupComplete: boolean;

  /**
   * Current wizard mode (quickstart or advanced).
   */
  mode: OnboardingMode;

  /**
   * Current step in progress (null if not in wizard).
   */
  currentStep: OnboardingStep | null;

  /**
   * History of completed steps with timestamps.
   */
  completedSteps: CompletedStepRecord[];

  /**
   * ISO 8601 timestamp of when onboarding was started.
   */
  startedAt: string;

  /**
   * ISO 8601 timestamp of when onboarding was completed (null if incomplete).
   */
  completedAt: string | null;

  /**
   * User's name captured during welcome step.
   */
  userName?: string;

  /**
   * Bot personality configuration.
   */
  personality?: PersonalityConfig;
}
