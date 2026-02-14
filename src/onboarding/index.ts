/**
 * Onboarding wizard types, configuration, and services.
 *
 * Barrel export for all onboarding-related modules.
 */

export {
  OnboardingEngine,
  type EngineState,
  type OnboardingEngineOptions,
  type OnboardingEvent,
  type OnboardingEventListener,
  type OnboardingStepHandler,
  type StepDefaults,
  type StepExecutionContext,
  type StepResult,
} from "./engine";

export {
  OnboardingCheckpointService,
  OnboardingError,
  type CheckpointServiceOptions,
} from "./checkpoint-service";

export {
  FirstRunDetector,
  type FirstRunDetectionResult,
  type FirstRunDetectorOptions,
  type FirstRunStatus,
} from "./first-run-detector";

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
