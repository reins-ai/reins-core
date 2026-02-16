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
