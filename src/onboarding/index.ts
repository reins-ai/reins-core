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
  PERSONALITY_PRESETS,
  getPresetPromptModifier,
  type PersonalityPromptDefinition,
} from "./personality-prompts";

export {
  DaemonInstallStep,
  type DaemonInstallStepOptions,
  ModelSelectionStep,
  type ModelSelectionStepOptions,
  PersonalityStep,
  type PersonalityStepOptions,
  ProviderSetupStep,
  type ProviderSetupStepOptions,
  WelcomeStep,
  type WelcomeStepOptions,
  WorkspaceStep,
} from "./steps";

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
