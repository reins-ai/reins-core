import { SkillError } from "./errors";
import type { SkillTrustLevel } from "./types";
import { type Result, err, ok } from "../result";

export const MAX_NAME_LENGTH = 64;
export const MAX_DESCRIPTION_LENGTH = 1024;
export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const RESERVED_NAME_TERMS = ["anthropic", "claude"];

/**
 * Configuration requirements for a skill.
 */
export interface SkillMetadataConfig {
  /** Environment variables required by the skill */
  envVars?: string[];
  /** Directories the skill needs to exist */
  stateDirs?: string[];
}

/**
 * Rich metadata extracted from SKILL.md YAML frontmatter.
 */
export interface SkillMetadata {
  /** Skill name — required, <=64 chars, lowercase/numbers/hyphens */
  name: string;
  /** Skill description — required, <=1024 chars, non-empty */
  description: string;

  /** Invocation trigger keywords/phrases */
  triggers?: string[];
  /** CLI tools the skill requires (e.g., ["git", "gh"]) */
  requiredTools?: string[];
  /** Organizational categories/tags */
  categories?: string[];
  /** Permission tier for script execution */
  trustLevel?: SkillTrustLevel;
  /** Configuration requirements */
  config?: SkillMetadataConfig;
  /** Target platforms */
  platforms?: string[];
  /** Skill version string */
  version?: string;
  /** Skill author */
  author?: string;

  /** Unknown YAML fields preserved for forward compatibility */
  extra?: Record<string, unknown>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateOptionalStringArrayField(
  raw: Record<string, unknown>,
  key: "triggers" | "requiredTools" | "categories" | "platforms",
): Result<string[] | undefined, SkillError> {
  const value = raw[key];
  if (value === undefined) {
    return ok(undefined);
  }

  if (!isStringArray(value)) {
    return err(new SkillError(`Metadata field \"${key}\" must be a string array`));
  }

  return ok(value);
}

function validateTrustLevel(value: unknown): Result<SkillTrustLevel | undefined, SkillError> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (value === "trusted" || value === "untrusted" || value === "verified") {
    return ok(value);
  }

  return err(
    new SkillError(
      "Metadata field \"trustLevel\" must be one of: trusted, untrusted, verified",
    ),
  );
}

function validateConfig(value: unknown): Result<SkillMetadataConfig | undefined, SkillError> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (!isRecord(value)) {
    return err(new SkillError('Metadata field "config" must be an object'));
  }

  const envVars = value.envVars;
  if (envVars !== undefined && !isStringArray(envVars)) {
    return err(new SkillError('Metadata field "config.envVars" must be a string array'));
  }

  const stateDirs = value.stateDirs;
  if (stateDirs !== undefined && !isStringArray(stateDirs)) {
    return err(new SkillError('Metadata field "config.stateDirs" must be a string array'));
  }

  return ok({
    envVars,
    stateDirs,
  });
}

function validateOptionalStringField(
  raw: Record<string, unknown>,
  key: "version" | "author",
): Result<string | undefined, SkillError> {
  const value = raw[key];
  if (value === undefined) {
    return ok(undefined);
  }

  if (typeof value !== "string") {
    return err(new SkillError(`Metadata field \"${key}\" must be a string`));
  }

  return ok(value);
}

export function validateMetadata(raw: Record<string, unknown>): Result<SkillMetadata, SkillError> {
  const name = raw.name;
  if (typeof name !== "string") {
    return err(new SkillError('Metadata field "name" is required and must be a string'));
  }

  if (name.length > MAX_NAME_LENGTH) {
    return err(
      new SkillError(
        `Metadata field \"name\" must be at most ${MAX_NAME_LENGTH} characters long`,
      ),
    );
  }

  if (!NAME_PATTERN.test(name)) {
    return err(new SkillError('Metadata field "name" must match /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/'));
  }

  const lowerName = name.toLowerCase();
  if (RESERVED_NAME_TERMS.some((term) => lowerName.includes(term))) {
    return err(new SkillError('Metadata field "name" cannot contain reserved terms: anthropic, claude'));
  }

  const description = raw.description;
  if (typeof description !== "string") {
    return err(new SkillError('Metadata field "description" is required and must be a string'));
  }

  if (description.trim().length === 0) {
    return err(new SkillError('Metadata field "description" must not be empty'));
  }

  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return err(
      new SkillError(
        `Metadata field \"description\" must be at most ${MAX_DESCRIPTION_LENGTH} characters long`,
      ),
    );
  }

  const triggersResult = validateOptionalStringArrayField(raw, "triggers");
  if (!triggersResult.ok) {
    return triggersResult;
  }

  const requiredToolsResult = validateOptionalStringArrayField(raw, "requiredTools");
  if (!requiredToolsResult.ok) {
    return requiredToolsResult;
  }

  const categoriesResult = validateOptionalStringArrayField(raw, "categories");
  if (!categoriesResult.ok) {
    return categoriesResult;
  }

  const platformsResult = validateOptionalStringArrayField(raw, "platforms");
  if (!platformsResult.ok) {
    return platformsResult;
  }

  const trustLevelResult = validateTrustLevel(raw.trustLevel);
  if (!trustLevelResult.ok) {
    return trustLevelResult;
  }

  const configResult = validateConfig(raw.config);
  if (!configResult.ok) {
    return configResult;
  }

  const versionResult = validateOptionalStringField(raw, "version");
  if (!versionResult.ok) {
    return versionResult;
  }

  const authorResult = validateOptionalStringField(raw, "author");
  if (!authorResult.ok) {
    return authorResult;
  }

  const knownKeys = new Set([
    "name",
    "description",
    "triggers",
    "requiredTools",
    "categories",
    "trustLevel",
    "config",
    "platforms",
    "version",
    "author",
  ]);
  const extra = Object.fromEntries(
    Object.entries(raw).filter(([key]) => !knownKeys.has(key)),
  );

  return ok({
    name,
    description,
    triggers: triggersResult.value,
    requiredTools: requiredToolsResult.value,
    categories: categoriesResult.value,
    trustLevel: trustLevelResult.value,
    config: configResult.value,
    platforms: platformsResult.value,
    version: versionResult.value,
    author: authorResult.value,
    extra: Object.keys(extra).length > 0 ? extra : undefined,
  });
}
