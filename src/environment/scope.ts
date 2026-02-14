import { err, ok, type Result } from "../result";
import { ENVIRONMENT_DOCUMENTS } from "./types";
import { EnvironmentScopeViolationError, type EnvironmentError } from "./errors";

export type SettingScope = "global" | "environment";

export const GLOBAL_SETTINGS = [
  "globalCredentials",
  "modelDefaults",
  "billing",
  "heartbeatIntervalMinutes",
] as const;

export const ENVIRONMENT_SETTINGS = ENVIRONMENT_DOCUMENTS;

const GLOBAL_ALIAS_MAP: Readonly<Record<string, (typeof GLOBAL_SETTINGS)[number]>> = {
  credentials: "globalCredentials",
  globalcredentials: "globalCredentials",
  models: "modelDefaults",
  modeldefaults: "modelDefaults",
  billing: "billing",
  heartbeatinterval: "heartbeatIntervalMinutes",
  heartbeatintervalminutes: "heartbeatIntervalMinutes",
};

const GLOBAL_NORMALIZED_KEYS = new Set<string>([
  ...GLOBAL_SETTINGS.map((key) => normalizeKey(key)),
  ...Object.keys(GLOBAL_ALIAS_MAP),
]);

const ENVIRONMENT_NORMALIZED_KEYS = new Set<string>(
  ENVIRONMENT_SETTINGS.map((key) => normalizeKey(key)),
);

export function classifyScope(setting: string): SettingScope {
  const normalized = normalizeKey(setting);

  if (GLOBAL_NORMALIZED_KEYS.has(normalized)) {
    return "global";
  }

  if (ENVIRONMENT_NORMALIZED_KEYS.has(normalized)) {
    return "environment";
  }

  return "environment";
}

export function validateScopeWrite(
  scope: SettingScope,
  target: "global" | "environment",
  value: unknown,
): Result<void, EnvironmentError> {
  void value;

  if (scope === "global" && target === "environment") {
    return err(
      new EnvironmentScopeViolationError(
        "Cannot write global settings into an environment. Global credentials, model defaults, billing, and heartbeat interval must remain global.",
      ),
    );
  }

  if (scope === "environment" && target === "global") {
    return err(
      new EnvironmentScopeViolationError(
        "Cannot write environment documents into global config. Personality, user, heartbeat, routines, goals, knowledge, tools, and boundaries must remain environment-scoped.",
      ),
    );
  }

  return ok(undefined);
}

export function isGlobalSetting(key: string): boolean {
  return classifyScope(key) === "global";
}

export function isEnvironmentSetting(key: string): boolean {
  return classifyScope(key) === "environment";
}

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}
