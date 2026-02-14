const ENVIRONMENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-_]{0,31}$/;
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

export const CONFIG_FORMAT_CANDIDATES = ["json", "json5", "toml"] as const;

export type ConfigFormatCandidate = (typeof CONFIG_FORMAT_CANDIDATES)[number];

export const SELECTED_CONFIG_FORMAT: ConfigFormatCandidate = "json5";

export const CONFIG_SCHEMA_VERSION = 1;
export const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 30;
export const MIN_HEARTBEAT_INTERVAL_MINUTES = 5;
export const MAX_HEARTBEAT_INTERVAL_MINUTES = 1440;
export const MIN_TEMPERATURE = 0;
export const MAX_TEMPERATURE = 2;
export const MIN_MAX_TOKENS = 1;
export const MAX_MAX_TOKENS = 128_000;

export const PROVIDER_KEY_TARGETS = [
  "anthropic",
  "openai",
  "google",
  "fireworks",
  "gateway",
] as const;

export type ProviderKeyTarget = (typeof PROVIDER_KEY_TARGETS)[number];

export interface GlobalCredentialsConfig {
  providerKeys: Partial<Record<ProviderKeyTarget, string>>;
  gatewayBaseUrl: string | null;
}

export interface ModelDefaultsConfig {
  provider: string | null;
  model: string | null;
  temperature: number;
  maxTokens: number;
}

export interface BillingConfig {
  mode: "off" | "warn" | "enforce";
  monthlySoftLimitUsd: number | null;
  monthlyHardLimitUsd: number | null;
  currencyCode: string;
}

export interface ReinsGlobalConfig {
  version: number;
  activeEnvironment: string;
  globalCredentials: GlobalCredentialsConfig;
  modelDefaults: ModelDefaultsConfig;
  billing: BillingConfig;
  heartbeatIntervalMinutes: number;
}

export interface ConfigValidationIssue {
  path: string;
  rule: string;
  message: string;
}

export interface ConfigValidationResult {
  config: ReinsGlobalConfig;
  issues: ConfigValidationIssue[];
  isValid: boolean;
}

export const DEFAULT_REINS_GLOBAL_CONFIG: ReinsGlobalConfig = {
  version: CONFIG_SCHEMA_VERSION,
  activeEnvironment: "default",
  globalCredentials: {
    providerKeys: {},
    gatewayBaseUrl: null,
  },
  modelDefaults: {
    provider: null,
    model: null,
    temperature: 0.7,
    maxTokens: 4096,
  },
  billing: {
    mode: "off",
    monthlySoftLimitUsd: null,
    monthlyHardLimitUsd: null,
    currencyCode: "USD",
  },
  heartbeatIntervalMinutes: DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
};

interface ConfigRecord extends Record<string, unknown> {
  version?: unknown;
  activeEnvironment?: unknown;
  globalCredentials?: unknown;
  modelDefaults?: unknown;
  billing?: unknown;
  heartbeatIntervalMinutes?: unknown;
}

export function validateConfigDraft(input: unknown): ConfigValidationResult {
  const issues: ConfigValidationIssue[] = [];
  const source = isRecord(input) ? (input as ConfigRecord) : {};

  const version = normalizeVersion(source.version, issues);
  const activeEnvironment = normalizeEnvironmentName(source.activeEnvironment, issues);
  const globalCredentials = normalizeGlobalCredentials(source.globalCredentials, issues);
  const modelDefaults = normalizeModelDefaults(source.modelDefaults, issues);
  const billing = normalizeBilling(source.billing, issues);
  const heartbeatIntervalMinutes = normalizeHeartbeatInterval(source.heartbeatIntervalMinutes, issues);

  const config: ReinsGlobalConfig = {
    version,
    activeEnvironment,
    globalCredentials,
    modelDefaults,
    billing,
    heartbeatIntervalMinutes,
  };

  if (
    config.billing.monthlySoftLimitUsd !== null
    && config.billing.monthlyHardLimitUsd !== null
    && config.billing.monthlySoftLimitUsd > config.billing.monthlyHardLimitUsd
  ) {
    issues.push({
      path: "billing",
      rule: "soft_limit_lte_hard_limit",
      message: "billing.monthlySoftLimitUsd must be less than or equal to billing.monthlyHardLimitUsd.",
    });
  }

  return {
    config,
    issues,
    isValid: issues.length === 0,
  };
}

function normalizeVersion(value: unknown, issues: ConfigValidationIssue[]): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= CONFIG_SCHEMA_VERSION) {
    return value;
  }

  if (value !== undefined) {
    issues.push({
      path: "version",
      rule: "integer_min_1",
      message: "version must be an integer greater than or equal to 1.",
    });
  }

  return CONFIG_SCHEMA_VERSION;
}

function normalizeEnvironmentName(value: unknown, issues: ConfigValidationIssue[]): string {
  if (typeof value === "string" && ENVIRONMENT_NAME_PATTERN.test(value)) {
    return value;
  }

  if (value !== undefined) {
    issues.push({
      path: "activeEnvironment",
      rule: "environment_slug",
      message: "activeEnvironment must match /^[a-z0-9][a-z0-9-_]{0,31}$/.",
    });
  }

  return DEFAULT_REINS_GLOBAL_CONFIG.activeEnvironment;
}

function normalizeGlobalCredentials(
  value: unknown,
  issues: ConfigValidationIssue[],
): GlobalCredentialsConfig {
  if (!isRecord(value)) {
    return DEFAULT_REINS_GLOBAL_CONFIG.globalCredentials;
  }

  const providerKeys: Partial<Record<ProviderKeyTarget, string>> = {};
  const providerKeysCandidate = value.providerKeys;

  if (isRecord(providerKeysCandidate)) {
    for (const target of PROVIDER_KEY_TARGETS) {
      const candidate = providerKeysCandidate[target];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        providerKeys[target] = candidate;
      } else if (candidate !== undefined) {
        issues.push({
          path: `globalCredentials.providerKeys.${target}`,
          rule: "non_empty_string",
          message: "provider key values must be non-empty strings when provided.",
        });
      }
    }
  } else if (providerKeysCandidate !== undefined) {
    issues.push({
      path: "globalCredentials.providerKeys",
      rule: "record",
      message: "globalCredentials.providerKeys must be an object keyed by provider target.",
    });
  }

  const gatewayBaseUrl = normalizeNullableNonEmptyString(
    value.gatewayBaseUrl,
    "globalCredentials.gatewayBaseUrl",
    issues,
  );

  return {
    providerKeys,
    gatewayBaseUrl,
  };
}

function normalizeModelDefaults(value: unknown, issues: ConfigValidationIssue[]): ModelDefaultsConfig {
  if (!isRecord(value)) {
    return DEFAULT_REINS_GLOBAL_CONFIG.modelDefaults;
  }

  return {
    provider: normalizeNullableNonEmptyString(value.provider, "modelDefaults.provider", issues),
    model: normalizeNullableNonEmptyString(value.model, "modelDefaults.model", issues),
    temperature: normalizeNumberInRange(
      value.temperature,
      MIN_TEMPERATURE,
      MAX_TEMPERATURE,
      "modelDefaults.temperature",
      issues,
      DEFAULT_REINS_GLOBAL_CONFIG.modelDefaults.temperature,
    ),
    maxTokens: normalizeIntegerInRange(
      value.maxTokens,
      MIN_MAX_TOKENS,
      MAX_MAX_TOKENS,
      "modelDefaults.maxTokens",
      issues,
      DEFAULT_REINS_GLOBAL_CONFIG.modelDefaults.maxTokens,
    ),
  };
}

function normalizeBilling(value: unknown, issues: ConfigValidationIssue[]): BillingConfig {
  if (!isRecord(value)) {
    return DEFAULT_REINS_GLOBAL_CONFIG.billing;
  }

  let mode: BillingConfig["mode"] = DEFAULT_REINS_GLOBAL_CONFIG.billing.mode;
  if (value.mode === "off" || value.mode === "warn" || value.mode === "enforce") {
    mode = value.mode;
  } else if (value.mode !== undefined) {
    issues.push({
      path: "billing.mode",
      rule: "enum",
      message: "billing.mode must be one of: off, warn, enforce.",
    });
  }

  const monthlySoftLimitUsd = normalizeNullableLimit(
    value.monthlySoftLimitUsd,
    "billing.monthlySoftLimitUsd",
    issues,
  );
  const monthlyHardLimitUsd = normalizeNullableLimit(
    value.monthlyHardLimitUsd,
    "billing.monthlyHardLimitUsd",
    issues,
  );

  const currencyCandidate = typeof value.currencyCode === "string" ? value.currencyCode.toUpperCase() : value.currencyCode;
  const currencyCode = normalizeCurrencyCode(currencyCandidate, issues);

  return {
    mode,
    monthlySoftLimitUsd,
    monthlyHardLimitUsd,
    currencyCode,
  };
}

function normalizeHeartbeatInterval(value: unknown, issues: ConfigValidationIssue[]): number {
  return normalizeIntegerInRange(
    value,
    MIN_HEARTBEAT_INTERVAL_MINUTES,
    MAX_HEARTBEAT_INTERVAL_MINUTES,
    "heartbeatIntervalMinutes",
    issues,
    DEFAULT_REINS_GLOBAL_CONFIG.heartbeatIntervalMinutes,
  );
}

function normalizeNullableNonEmptyString(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  issues.push({
    path,
    rule: "nullable_non_empty_string",
    message: `${path} must be null or a non-empty string.`,
  });

  return null;
}

function normalizeNumberInRange(
  value: unknown,
  min: number,
  max: number,
  path: string,
  issues: ConfigValidationIssue[],
  fallback: number,
): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= min && value <= max) {
    return value;
  }

  if (value !== undefined) {
    issues.push({
      path,
      rule: `number_range_${min}_${max}`,
      message: `${path} must be a number in range [${min}, ${max}].`,
    });
  }

  return fallback;
}

function normalizeIntegerInRange(
  value: unknown,
  min: number,
  max: number,
  path: string,
  issues: ConfigValidationIssue[],
  fallback: number,
): number {
  if (typeof value === "number" && Number.isInteger(value) && value >= min && value <= max) {
    return value;
  }

  if (value !== undefined) {
    issues.push({
      path,
      rule: `integer_range_${min}_${max}`,
      message: `${path} must be an integer in range [${min}, ${max}].`,
    });
  }

  return fallback;
}

function normalizeNullableLimit(
  value: unknown,
  path: string,
  issues: ConfigValidationIssue[],
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }

  issues.push({
    path,
    rule: "nullable_non_negative_number",
    message: `${path} must be null or a number greater than or equal to 0.`,
  });

  return null;
}

function normalizeCurrencyCode(value: unknown, issues: ConfigValidationIssue[]): string {
  if (typeof value === "string" && CURRENCY_CODE_PATTERN.test(value)) {
    return value;
  }

  if (value !== undefined) {
    issues.push({
      path: "billing.currencyCode",
      rule: "iso4217_alpha3",
      message: "billing.currencyCode must be a 3-letter uppercase ISO 4217 code.",
    });
  }

  return DEFAULT_REINS_GLOBAL_CONFIG.billing.currencyCode;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
