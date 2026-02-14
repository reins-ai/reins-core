/**
 * Onboarding wizard types, configuration, and services.
 *
 * Barrel export for all onboarding-related modules.
 */

export {
  OnboardingCheckpointService,
  OnboardingError,
  type CheckpointServiceOptions,
} from "./checkpoint-service";

export {
  ONBOARDING_STEPS,
  type CompletedStepRecord,
  type OnboardingConfig,
  type OnboardingMode,
  type OnboardingStep,
  type OnboardingStepStatus,
  type PersonalityConfig,
  type PersonalityPreset,
} from "./types";
