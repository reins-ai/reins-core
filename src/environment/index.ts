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
  EnvironmentSwitchFailedError,
  InvalidEnvironmentNameError,
} from "./errors";
export type { EnvironmentErrorCode } from "./errors";
export { ENVIRONMENT_ERROR_CODES } from "./errors";

export { FileEnvironmentResolver } from "./file-resolver";
export { DocumentLoader } from "./document-loader";

export { KnowledgeService, parseKnowledgeDocument } from "./knowledge";
export type { KnowledgeDocument, KnowledgeEntry } from "./knowledge";

export { EnvironmentSwitchService } from "./switch-service";
export type {
  EnvironmentSwitchEvent,
  EnvironmentSwitchListener,
  EnvironmentSwitchResult,
} from "./switch-service";

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
