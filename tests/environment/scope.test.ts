import { describe, expect, it } from "bun:test";

import {
  ENVIRONMENT_SETTINGS,
  GLOBAL_SETTINGS,
  classifyScope,
  isEnvironmentSetting,
  isGlobalSetting,
  validateScopeWrite,
} from "../../src/environment/scope";

describe("classifyScope", () => {
  it("classifies all global config keys as global", () => {
    for (const key of GLOBAL_SETTINGS) {
      expect(classifyScope(key)).toBe("global");
      expect(isGlobalSetting(key)).toBe(true);
      expect(isEnvironmentSetting(key)).toBe(false);
    }
  });

  it("classifies all environment documents as environment", () => {
    for (const document of ENVIRONMENT_SETTINGS) {
      expect(classifyScope(document)).toBe("environment");
      expect(isGlobalSetting(document)).toBe(false);
      expect(isEnvironmentSetting(document)).toBe(true);
    }
  });
});

describe("validateScopeWrite", () => {
  it("rejects writing credentials to environment scope", () => {
    const result = validateScopeWrite(classifyScope("globalCredentials"), "environment", {
      providerKeys: {
        openai: "sk-test",
      },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCOPE_VIOLATION");
    }
  });

  it("rejects writing personality document to global scope", () => {
    const result = validateScopeWrite(classifyScope("PERSONALITY"), "global", "persona");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("SCOPE_VIOLATION");
    }
  });

  it("allows valid same-scope writes", () => {
    const globalResult = validateScopeWrite(classifyScope("modelDefaults"), "global", {
      provider: "openai",
      model: "gpt-5-mini",
    });

    const environmentResult = validateScopeWrite(
      classifyScope("BOUNDARIES"),
      "environment",
      "no financial advice",
    );

    expect(globalResult.ok).toBe(true);
    expect(environmentResult.ok).toBe(true);
  });

  it("prevents cross-scope leaks for every global and environment key", () => {
    for (const globalSetting of GLOBAL_SETTINGS) {
      const globalWriteToEnvironment = validateScopeWrite(
        classifyScope(globalSetting),
        "environment",
        "value",
      );
      expect(globalWriteToEnvironment.ok).toBe(false);
      if (!globalWriteToEnvironment.ok) {
        expect(globalWriteToEnvironment.error.code).toBe("SCOPE_VIOLATION");
      }

      const globalWriteToGlobal = validateScopeWrite(
        classifyScope(globalSetting),
        "global",
        "value",
      );
      expect(globalWriteToGlobal.ok).toBe(true);
    }

    for (const environmentSetting of ENVIRONMENT_SETTINGS) {
      const environmentWriteToGlobal = validateScopeWrite(
        classifyScope(environmentSetting),
        "global",
        "value",
      );
      expect(environmentWriteToGlobal.ok).toBe(false);
      if (!environmentWriteToGlobal.ok) {
        expect(environmentWriteToGlobal.error.code).toBe("SCOPE_VIOLATION");
      }

      const environmentWriteToEnvironment = validateScopeWrite(
        classifyScope(environmentSetting),
        "environment",
        "value",
      );
      expect(environmentWriteToEnvironment.ok).toBe(true);
    }
  });
});
