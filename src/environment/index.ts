export {
  bootstrapInstallRoot,
  buildInstallPaths,
  generateDefaultConfigContent,
  resolveInstallRoot,
} from "./bootstrap";
export type { BootstrapResult, InstallPaths } from "./bootstrap";

export {
  DocumentNotFoundError,
  EnvironmentBootstrapFailedError,
  EnvironmentError,
  EnvironmentNotFoundError,
  EnvironmentScopeViolationError,
  InvalidEnvironmentNameError,
} from "./errors";
export type { EnvironmentErrorCode } from "./errors";
export { ENVIRONMENT_ERROR_CODES } from "./errors";

export type { EnvironmentResolver } from "./resolver";

export {
  ENVIRONMENT_SETTINGS,
  GLOBAL_SETTINGS,
  classifyScope,
  isEnvironmentSetting,
  isGlobalSetting,
  validateScopeWrite,
} from "./scope";
export type { SettingScope } from "./scope";

export {
  ENVIRONMENT_DOCUMENTS,
} from "./types";
export type {
  DocumentResolutionResult,
  DocumentSource,
  Environment,
  EnvironmentDocument,
  EnvironmentDocumentContent,
  EnvironmentDocumentMap,
  OverlayResolution,
} from "./types";
