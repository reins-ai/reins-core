/**
 * Integrations module — modular integration system for external services.
 *
 * Provides a standardized 5-file integration contract (manifest.json + auth.ts +
 * operations/index.ts + individual operation files + README.md) for connecting
 * Reins to external services like Obsidian, Gmail, and Spotify.
 *
 * @module integrations
 */

// Core types and interfaces
export type {
  ApiKeyAuthRequirement,
  AuthRequirement,
  Integration,
  IntegrationCategory,
  IntegrationConfig,
  IntegrationManifest,
  IntegrationOperation,
  IntegrationOperationParameterSchema,
  IntegrationPlatform,
  IntegrationState,
  IntegrationStatus,
  LocalPathAuthRequirement,
  OAuth2AuthRequirement,
} from "./types";

// Manifest validation
export {
  validateIntegrationManifest,
  type ValidationResult as IntegrationValidationResult,
} from "./manifest";

// Integration registry
export { IntegrationRegistry } from "./registry";

// Error types
export {
  IntegrationError,
  INTEGRATION_ERROR_CODES,
  type IntegrationErrorCode,
} from "./errors";

export {
  getCapabilityIndexTokenCount,
  IntegrationMetaTool,
  INTEGRATION_META_TOOL_ACTIONS,
  INTEGRATION_META_TOOL_DEFINITION,
  INTEGRATION_META_TOOL_MAX_TOKENS,
  getIntegrationMetaToolTokenCount,
  type IntegrationMetaToolAction,
} from "./meta-tool";

export {
  formatDetailResult,
  formatErrorResult,
  formatListResult,
  type CompactResult,
  type DetailResultFormatterOptions,
  type ErrorResultFormatterOptions,
  type IntegrationResult,
  type IntegrationResultKind,
  type ListResultFormatterOptions,
  type RichResult,
} from "./result";

// Intent-routed fallback injection
export {
  IntentRouter,
  type DetectedIntent,
  type FallbackInjection,
} from "./intent-router";

// Integration state machine
export {
  IntegrationStateMachine,
  type StateChangeListener,
} from "./state-machine";

export {
  InMemoryCredentialVault,
  IntegrationCredentialVault,
  type ApiKeyCredential,
  type CredentialStatus,
  type CredentialVault,
  type IntegrationCredential,
  type IntegrationCredentialVaultOptions,
  type LocalPathCredential,
  type OAuthCredential,
} from "./credentials";
