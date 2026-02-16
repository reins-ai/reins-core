/**
 * Integration manifest validation.
 *
 * Follows the same validation pattern as plugins/manifest.ts:
 * accumulate errors, return ValidationResult<IntegrationManifest>.
 */

import type {
  AuthRequirement,
  IntegrationCategory,
  IntegrationManifest,
  IntegrationOperation,
  IntegrationOperationParameterSchema,
  IntegrationPlatform,
} from "./types";

// ---------------------------------------------------------------------------
// Validation result (same shape as plugins/manifest.ts)
// ---------------------------------------------------------------------------

export type ValidationResult<T> =
  | { valid: true; value: T }
  | { valid: false; errors: string[] };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

const KEBAB_CASE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const VALID_AUTH_TYPES: ReadonlySet<string> = new Set<string>([
  "oauth2",
  "api_key",
  "local_path",
]);

const VALID_CATEGORIES: ReadonlySet<string> = new Set<string>([
  "productivity",
  "communication",
  "media",
  "developer",
  "files",
  "knowledge",
  "automation",
  "utilities",
  "other",
]);

const VALID_PLATFORMS: ReadonlySet<string> = new Set<string>([
  "daemon",
  "tui",
  "desktop",
  "mobile",
  "api",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function isValidSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function isValidKebabCase(value: string): boolean {
  return KEBAB_CASE_PATTERN.test(value);
}

export function validateIntegrationManifest(
  raw: unknown,
): ValidationResult<IntegrationManifest> {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { valid: false, errors: ["Manifest must be an object"] };
  }

  // Required string fields
  const id = readRequiredString(raw, "id", errors);
  const name = readRequiredString(raw, "name", errors);
  const description = readRequiredString(raw, "description", errors);
  const version = readRequiredString(raw, "version", errors);
  const author = readRequiredString(raw, "author", errors);

  // ID must be kebab-case
  if (id !== undefined && id.length > 0 && !isValidKebabCase(id)) {
    errors.push("id must be kebab-case (lowercase alphanumeric with hyphens)");
  }

  // Version must be valid semver
  if (version !== undefined && version.length > 0 && !isValidSemver(version)) {
    errors.push("version must be a valid semver string");
  }

  // Category validation
  const category = readRequiredString(raw, "category", errors);
  if (
    category !== undefined &&
    category.length > 0 &&
    !VALID_CATEGORIES.has(category)
  ) {
    errors.push(
      `category must be one of: ${[...VALID_CATEGORIES].join(", ")}`,
    );
  }

  // Auth requirement validation
  const auth = readAuthRequirement(raw.auth, errors);

  // Permissions validation
  const permissions = readStringArray(raw.permissions, "permissions", errors);

  // Platforms validation
  const platforms = readPlatforms(raw.platforms, errors);

  // Operations validation
  const operations = readOperations(raw.operations, errors);

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const manifest: IntegrationManifest = {
    id,
    name,
    description,
    version,
    author,
    category: category as IntegrationCategory,
    auth,
    permissions,
    platforms,
    operations,
  };

  return { valid: true, value: manifest };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRequiredString(
  source: Record<string, unknown>,
  field: string,
  errors: string[],
): string {
  const value = source[field];

  if (typeof value !== "string") {
    errors.push(`${field} is required and must be a string`);
    return "";
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push(`${field} must not be empty`);
    return "";
  }

  return trimmed;
}

function readStringArray(
  value: unknown,
  field: string,
  errors: string[],
): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} is required and must be an array`);
    return [];
  }

  const result: string[] = [];
  const invalid: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      invalid.push(String(item));
      continue;
    }
    result.push(item);
  }

  if (invalid.length > 0) {
    errors.push(`${field} contains non-string value(s): ${invalid.join(", ")}`);
  }

  return result;
}

function readAuthRequirement(
  value: unknown,
  errors: string[],
): AuthRequirement {
  if (!isRecord(value)) {
    errors.push("auth is required and must be an object");
    return { type: "api_key" };
  }

  const type = value.type;
  if (typeof type !== "string") {
    errors.push("auth.type is required and must be a string");
    return { type: "api_key" };
  }

  if (!VALID_AUTH_TYPES.has(type)) {
    errors.push(
      `auth.type must be one of: ${[...VALID_AUTH_TYPES].join(", ")}`,
    );
  }

  // Build the auth requirement based on type
  switch (type) {
    case "oauth2":
      return readOAuth2Auth(value, errors);
    case "api_key":
      return readApiKeyAuth(value, errors);
    case "local_path":
      return readLocalPathAuth(value, errors);
    default:
      // Invalid type — return a placeholder to continue collecting errors
      return { type: type as "api_key" };
  }
}

function readOAuth2Auth(
  value: Record<string, unknown>,
  errors: string[],
): AuthRequirement {
  const scopes = readOptionalStringArray(value.scopes, "auth.scopes", errors);

  const result: AuthRequirement = {
    type: "oauth2",
    scopes: scopes ?? [],
  };

  if (value.authorizationUrl !== undefined) {
    if (typeof value.authorizationUrl !== "string") {
      errors.push("auth.authorizationUrl must be a string when provided");
    } else {
      result.authorizationUrl = value.authorizationUrl;
    }
  }

  if (value.tokenUrl !== undefined) {
    if (typeof value.tokenUrl !== "string") {
      errors.push("auth.tokenUrl must be a string when provided");
    } else {
      result.tokenUrl = value.tokenUrl;
    }
  }

  if (value.revokeUrl !== undefined) {
    if (typeof value.revokeUrl !== "string") {
      errors.push("auth.revokeUrl must be a string when provided");
    } else {
      result.revokeUrl = value.revokeUrl;
    }
  }

  if (value.pkce !== undefined) {
    if (typeof value.pkce !== "boolean") {
      errors.push("auth.pkce must be a boolean when provided");
    } else {
      result.pkce = value.pkce;
    }
  }

  return result;
}

function readApiKeyAuth(
  value: Record<string, unknown>,
  errors: string[],
): AuthRequirement {
  const result: AuthRequirement = { type: "api_key" };

  if (value.headerName !== undefined) {
    if (typeof value.headerName !== "string") {
      errors.push("auth.headerName must be a string when provided");
    } else {
      result.headerName = value.headerName;
    }
  }

  if (value.envVar !== undefined) {
    if (typeof value.envVar !== "string") {
      errors.push("auth.envVar must be a string when provided");
    } else {
      result.envVar = value.envVar;
    }
  }

  if (value.format !== undefined) {
    if (typeof value.format !== "string") {
      errors.push("auth.format must be a string when provided");
    } else {
      result.format = value.format;
    }
  }

  return result;
}

function readLocalPathAuth(
  value: Record<string, unknown>,
  errors: string[],
): AuthRequirement {
  const result: AuthRequirement = { type: "local_path" };

  if (value.pathLabel !== undefined) {
    if (typeof value.pathLabel !== "string") {
      errors.push("auth.pathLabel must be a string when provided");
    } else {
      result.pathLabel = value.pathLabel;
    }
  }

  if (value.mustExist !== undefined) {
    if (typeof value.mustExist !== "boolean") {
      errors.push("auth.mustExist must be a boolean when provided");
    } else {
      result.mustExist = value.mustExist;
    }
  }

  if (value.requiresWriteAccess !== undefined) {
    if (typeof value.requiresWriteAccess !== "boolean") {
      errors.push("auth.requiresWriteAccess must be a boolean when provided");
    } else {
      result.requiresWriteAccess = value.requiresWriteAccess;
    }
  }

  return result;
}

function readOptionalStringArray(
  value: unknown,
  field: string,
  errors: string[],
): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings when provided`);
    return undefined;
  }

  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      errors.push(`${field} must contain only strings`);
      return result;
    }
    result.push(item);
  }

  return result;
}

function readPlatforms(
  value: unknown,
  errors: string[],
): IntegrationPlatform[] {
  if (!Array.isArray(value)) {
    errors.push("platforms is required and must be an array");
    return [];
  }

  if (value.length === 0) {
    errors.push("platforms must contain at least one platform");
    return [];
  }

  const result: IntegrationPlatform[] = [];
  const invalid: string[] = [];

  for (const item of value) {
    if (typeof item !== "string") {
      invalid.push(String(item));
      continue;
    }

    if (!VALID_PLATFORMS.has(item)) {
      invalid.push(item);
      continue;
    }

    result.push(item as IntegrationPlatform);
  }

  if (invalid.length > 0) {
    errors.push(
      `platforms contains invalid value(s): ${invalid.join(", ")}. Valid values: ${[...VALID_PLATFORMS].join(", ")}`,
    );
  }

  return result;
}

function readOperations(
  value: unknown,
  errors: string[],
): IntegrationOperation[] {
  if (!Array.isArray(value)) {
    errors.push("operations is required and must be an array");
    return [];
  }

  if (value.length === 0) {
    errors.push("operations must contain at least one operation");
    return [];
  }

  const result: IntegrationOperation[] = [];

  for (let i = 0; i < value.length; i++) {
    const op = value[i];
    const prefix = `operations[${i}]`;

    if (!isRecord(op)) {
      errors.push(`${prefix} must be an object`);
      continue;
    }

    const opErrors: string[] = [];
    const opName = readRequiredString(op, "name", opErrors);
    const opDescription = readRequiredString(op, "description", opErrors);
    const opParameters = readParameterSchema(
      op.parameters,
      prefix,
      opErrors,
    );

    if (opName !== undefined && opName.length > 0 && !isValidKebabCase(opName)) {
      opErrors.push(`${prefix}.name must be kebab-case`);
    }

    if (opErrors.length > 0) {
      for (const e of opErrors) {
        // Prefix operation-level field errors with the operation index
        errors.push(e.startsWith(prefix) ? e : `${prefix}.${e}`);
      }
      continue;
    }

    result.push({
      name: opName,
      description: opDescription,
      parameters: opParameters,
    });
  }

  return result;
}

function readParameterSchema(
  value: unknown,
  prefix: string,
  errors: string[],
): IntegrationOperationParameterSchema {
  if (value === undefined || value === null) {
    errors.push(`${prefix}.parameters is required and must be an object or array`);
    return {};
  }

  // Accept both object (JSON-schema style) and array (legacy list style)
  if (isRecord(value)) {
    return value as IntegrationOperationParameterSchema;
  }

  // Accept array as a convenience — convert to JSON-schema-like object
  if (Array.isArray(value)) {
    return readParameterSchemaFromArray(value, prefix, errors);
  }

  errors.push(`${prefix}.parameters must be an object or array`);
  return {};
}

function readParameterSchemaFromArray(
  value: unknown[],
  prefix: string,
  errors: string[],
): IntegrationOperationParameterSchema {
  const properties: Record<string, IntegrationOperationParameterSchema> = {};
  const required: string[] = [];

  for (let i = 0; i < value.length; i++) {
    const param = value[i];
    const paramPrefix = `${prefix}.parameters[${i}]`;

    if (!isRecord(param)) {
      errors.push(`${paramPrefix} must be an object`);
      continue;
    }

    const paramErrors: string[] = [];
    const paramName = readRequiredString(param, "name", paramErrors);
    const paramType = readRequiredString(param, "type", paramErrors);
    const paramDescription = readRequiredString(
      param,
      "description",
      paramErrors,
    );

    if (param.required !== undefined && typeof param.required !== "boolean") {
      paramErrors.push("required must be a boolean when provided");
    }

    if (paramErrors.length > 0) {
      for (const e of paramErrors) {
        errors.push(`${paramPrefix}.${e}`);
      }
      continue;
    }

    properties[paramName] = {
      type: paramType,
      description: paramDescription,
    };

    if (param.required === true) {
      required.push(paramName);
    }
  }

  const schema: IntegrationOperationParameterSchema = {
    type: "object",
    properties,
  };

  if (required.length > 0) {
    schema.required = required;
  }

  return schema;
}
