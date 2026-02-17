export * from "./context";
export * from "./config";
export * from "./conversation";
export * from "./cron/scheduler";
export * from "./cron/store";
export * from "./cron/policy";
export * from "./cron/rate-limit";
export * from "./cron/executor";
export * from "./cron/types";
export * from "./cron/jobs/heartbeat-job";
export * from "./daemon/runtime";
export * from "./daemon/service-installer";
export * from "./daemon/paths";
export * from "./daemon/profile-store";
export * from "./daemon/profile-types";
export * from "./daemon/token-manager";
export * from "./daemon/transport-probe";
export * from "./daemon/types";
export * from "./daemon/environment-api";
export * from "./environment";
export * from "./errors";
export * from "./harness";
export * from "./heartbeat";
export * from "./integrations";
export * from "./marketplace";
export * from "./memory";
export * from "./persona";
export * from "./plugins";
export * from "./providers";
export * from "./result";
export * from "./security/keychain-fallback";
export * from "./security/keychain-provider";
export * from "./security/machine-auth";
export * from "./security/security-error";
export * from "./sync/account-sync";
export * from "./sync/policy";
export * from "./sync/triggers";
export * from "./sync/types";
export * from "./streaming";
export * from "./tokens";
export * from "./tools";
export * from "./tools/schedule";
export * from "./types";
export * from "./utils";
export * from "./voice";

// Onboarding — explicit re-exports to avoid StepResult collision with harness
export {
  OnboardingEngine,
  type EngineState,
  type OnboardingEngineOptions,
  type OnboardingEvent,
  type OnboardingEventListener,
  type OnboardingStepHandler,
  type StepDefaults,
  type StepExecutionContext,
  type StepResult as OnboardingStepResult,
} from "./onboarding/engine";
export {
  OnboardingCheckpointService,
  OnboardingError,
  type CheckpointServiceOptions,
} from "./onboarding/checkpoint-service";
export {
  FirstRunDetector,
  type FirstRunDetectionResult,
  type FirstRunDetectorOptions,
  type FirstRunStatus,
} from "./onboarding/first-run-detector";
export {
  PERSONALITY_PRESETS,
  getPresetPromptModifier,
  type PersonalityPromptDefinition,
} from "./onboarding/personality-prompts";
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
} from "./onboarding/steps";
export {
  ONBOARDING_STEPS,
  type CompletedStepRecord,
  type OnboardingConfig,
  type OnboardingMode,
  type OnboardingStep,
  type OnboardingStepStatus,
  type PersonalityConfig,
  type PersonalityPreset,
} from "./onboarding/types";
