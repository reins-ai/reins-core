import type { Result } from "../result";

/**
 * Supported integration categories for discovery and filtering.
 */
export type IntegrationCategory =
  | "productivity"
  | "communication"
  | "media"
  | "developer"
  | "files"
  | "knowledge"
  | "automation"
  | "utilities"
  | "other";

/**
 * Supported platforms where an integration can be surfaced.
 */
export type IntegrationPlatform = "daemon" | "tui" | "desktop" | "mobile" | "api";

/**
 * OAuth2 authentication requirement metadata.
 */
export interface OAuth2AuthRequirement {
  type: "oauth2";
  scopes: string[];
  authorizationUrl?: string;
  tokenUrl?: string;
  revokeUrl?: string;
  pkce?: boolean;
}

/**
 * API key authentication requirement metadata.
 */
export interface ApiKeyAuthRequirement {
  type: "api_key";
  headerName?: string;
  envVar?: string;
  format?: string;
}

/**
 * Local filesystem path authentication requirement metadata.
 */
export interface LocalPathAuthRequirement {
  type: "local_path";
  pathLabel?: string;
  mustExist?: boolean;
  requiresWriteAccess?: boolean;
}

/**
 * Authentication requirements supported by integrations.
 */
export type AuthRequirement = OAuth2AuthRequirement | ApiKeyAuthRequirement | LocalPathAuthRequirement;

/**
 * Runtime integration lifecycle states.
 */
export enum IntegrationState {
  INSTALLED = "installed",
  CONFIGURED = "configured",
  CONNECTED = "connected",
  ACTIVE = "active",
  SUSPENDED = "suspended",
  DISCONNECTED = "disconnected",
}

/**
 * Integration status indicator values used by management surfaces.
 */
export type IntegrationStatusIndicator =
  | "connected"
  | "error"
  | "auth_expired"
  | "suspended"
  | "disconnected";

/**
 * Runtime status snapshot for an integration instance.
 */
export interface IntegrationStatus {
  indicator: IntegrationStatusIndicator;
  state: IntegrationState;
  lastError?: string;
  updatedAt: Date;
}

/**
 * JSON-schema-like shape used for operation parameter definitions.
 */
export interface IntegrationOperationParameterSchema {
  type?: string;
  description?: string;
  properties?: Record<string, IntegrationOperationParameterSchema>;
  required?: string[];
  items?: IntegrationOperationParameterSchema;
  enum?: string[];
  additionalProperties?: boolean | IntegrationOperationParameterSchema;
}

/**
 * Integration operation definition exposed to discovery and execution flows.
 */
export interface IntegrationOperation {
  name: string;
  description: string;
  parameters: IntegrationOperationParameterSchema;
}

/**
 * Static metadata contract required for every integration manifest.
 */
export interface IntegrationManifest {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  category: IntegrationCategory;
  auth: AuthRequirement;
  permissions: string[];
  platforms: IntegrationPlatform[];
  operations: IntegrationOperation[];
}

/**
 * Runtime configuration for a loaded integration instance.
 */
export interface IntegrationConfig {
  id: string;
  enabled: boolean;
  settings?: Record<string, unknown>;
  authConfig?: Record<string, unknown>;
}

/**
 * Contract implemented by all integrations.
 */
export interface Integration {
  readonly config: IntegrationConfig;
  readonly manifest: IntegrationManifest;
  connect(): Promise<Result<void>>;
  disconnect(): Promise<Result<void>>;
  getStatus(): IntegrationStatus;
  getOperations(): IntegrationOperation[];
  execute(operationName: string, args: Record<string, unknown>): Promise<Result<unknown>>;
}
