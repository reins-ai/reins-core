import type { PluginManifest, PluginPermission } from "../types";

export type ValidationResult<T> = { valid: true; value: T } | { valid: false; errors: string[] };

const SEMVER_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PLUGIN_NAME_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;
const ENTRYPOINT_PATTERN = /\.(?:ts|js)$/;

export const PLUGIN_PERMISSION_VALUES: PluginPermission[] = [
  "read_conversations",
  "write_conversations",
  "read_calendar",
  "write_calendar",
  "read_notes",
  "write_notes",
  "read_reminders",
  "write_reminders",
  "network_access",
  "file_access",
  "schedule_cron",
  "admin_cron",
];

const PLUGIN_PERMISSION_SET = new Set<string>(PLUGIN_PERMISSION_VALUES);

export function isValidSemver(value: string): boolean {
  return SEMVER_PATTERN.test(value);
}

export function validateManifest(raw: unknown): ValidationResult<PluginManifest> {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { valid: false, errors: ["Manifest must be an object"] };
  }

  const name = readRequiredString(raw, "name", errors);
  const version = readRequiredString(raw, "version", errors);
  const description = readRequiredString(raw, "description", errors);
  const author = readRequiredString(raw, "author", errors);
  const entryPoint = readRequiredString(raw, "entryPoint", errors);
  const permissions = readPermissions(raw.permissions, errors);
  const dependencies = readStringRecord(raw.dependencies, "dependencies", errors);
  const homepage = readOptionalString(raw, "homepage", errors);
  const repository = readOptionalString(raw, "repository", errors);
  const license = readOptionalString(raw, "license", errors);
  const minReinsVersion = readOptionalString(raw, "minReinsVersion", errors);

  if (name !== undefined && !PLUGIN_NAME_PATTERN.test(name)) {
    errors.push("name must use alphanumeric characters and hyphens only");
  }

  if (version !== undefined && !isValidSemver(version)) {
    errors.push("version must be a valid semver string");
  }

  if (entryPoint !== undefined && !ENTRYPOINT_PATTERN.test(entryPoint)) {
    errors.push("entryPoint must end with .ts or .js");
  }

  if (entryPoint !== undefined && entryPoint.includes("\0")) {
    errors.push("entryPoint must not contain null bytes");
  }

  if (entryPoint !== undefined && hasPathTraversal(entryPoint)) {
    errors.push("entryPoint must not contain path traversal segments");
  }

  if (minReinsVersion !== undefined && !isValidSemver(minReinsVersion)) {
    errors.push("minReinsVersion must be a valid semver string");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const manifest: PluginManifest = {
    name,
    version,
    description,
    author,
    permissions,
    entryPoint,
  };

  if (dependencies) {
    manifest.dependencies = dependencies;
  }

  if (homepage) {
    manifest.homepage = homepage;
  }

  if (repository) {
    manifest.repository = repository;
  }

  if (license) {
    manifest.license = license;
  }

  if (minReinsVersion) {
    manifest.minReinsVersion = minReinsVersion;
  }

  return { valid: true, value: manifest };
}

function hasPathTraversal(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  return normalized.split("/").some((segment) => segment === "..");
}

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

function readOptionalString(
  source: Record<string, unknown>,
  field: string,
  errors: string[],
): string | undefined {
  const value = source[field];
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "string") {
    errors.push(`${field} must be a string when provided`);
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    errors.push(`${field} must not be empty when provided`);
    return undefined;
  }

  return trimmed;
}

function readPermissions(value: unknown, errors: string[]): PluginPermission[] {
  if (!Array.isArray(value)) {
    errors.push("permissions is required and must be an array");
    return [];
  }

  const invalidValues: string[] = [];
  const parsed: PluginPermission[] = [];

  for (const permission of value) {
    if (typeof permission !== "string") {
      invalidValues.push(String(permission));
      continue;
    }

    if (!PLUGIN_PERMISSION_SET.has(permission)) {
      invalidValues.push(permission);
      continue;
    }

    parsed.push(permission as PluginPermission);
  }

  if (invalidValues.length > 0) {
    errors.push(`permissions contains invalid value(s): ${invalidValues.join(", ")}`);
  }

  return parsed;
}

function readStringRecord(
  value: unknown,
  field: string,
  errors: string[],
): Record<string, string> | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!isRecord(value)) {
    errors.push(`${field} must be an object of string values`);
    return undefined;
  }

  const output: Record<string, string> = {};

  for (const [key, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      errors.push(`${field}.${key} must be a string`);
      continue;
    }

    output[key] = entryValue;
  }

  return output;
}
