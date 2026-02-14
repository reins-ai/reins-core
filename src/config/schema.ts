import { validateConfigDraft, type ConfigValidationResult } from "./format-decision";

const ENVIRONMENT_NAME_PATTERN = /^[a-z][a-z0-9-_]{0,31}$/;

export function validateGlobalConfig(input: unknown): ConfigValidationResult {
  return validateConfigDraft(input);
}

export function isValidEnvironmentName(name: string): boolean {
  return ENVIRONMENT_NAME_PATTERN.test(name);
}
