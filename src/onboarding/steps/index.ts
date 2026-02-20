export {
  getProviderSetupCopy,
  getWelcomeCopy,
  getWorkspaceCopy,
  PROVIDER_COPY_VARIANTS,
  WELCOME_COPY_VARIANTS,
  WORKSPACE_COPY_VARIANTS,
  type ProviderSetupCopy,
  type WelcomeCopy,
  type WorkspaceCopy,
} from "./copy";

export {
  DaemonInstallStep,
  type DaemonInstallStepOptions,
} from "./daemon-install";

export {
  ModelSelectionStep,
  type AvailableModel,
  type ModelSelectionStepOptions,
} from "./model-selection";

export {
  PersonalityStep,
  type PersonalityStepOptions,
} from "./personality";

export {
  ProviderSetupStep,
  type ProviderDetectionResult,
  type ProviderDisplayInfo,
  type ProviderSetupStepOptions,
} from "./provider-setup";

export type {
  OnboardingStepHandler,
  StepDefaults,
  StepExecutionContext,
  StepResult,
} from "./types";

export {
  WelcomeStep,
  type WelcomeStepOptions,
} from "./welcome";

export {
  WorkspaceStep,
} from "./workspace";
