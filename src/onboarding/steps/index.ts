export {
  DAEMON_INSTALL_COPY_VARIANTS,
  FRIENDLY_MODEL_NAME_MAP,
  MODEL_SELECTION_COPY_VARIANTS,
  PROVIDER_COPY_VARIANTS,
  WELCOME_COPY_VARIANTS,
  WORKSPACE_COPY_VARIANTS,
  getDaemonInstallCopy,
  getFriendlyModelName,
  getModelSelectionCopy,
  getProviderSetupCopy,
  getWelcomeCopy,
  getWorkspaceCopy,
  type DaemonInstallCopy,
  type ModelSelectionCopy,
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
  type DisplayModel,
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
  DEFAULT_PERSONA,
  WelcomeStep,
  type Persona,
  type WelcomeStepOptions,
} from "./welcome";

export {
  WorkspaceStep,
} from "./workspace";

export {
  FeatureDiscoveryStep,
} from "./feature-discovery";
