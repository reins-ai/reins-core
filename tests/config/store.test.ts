import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConfigStore,
  DEFAULT_REINS_GLOBAL_CONFIG,
  type ReinsGlobalConfig,
} from "../../src/config";

const createdDirectories: string[] = [];

async function createTempConfigPath(fileName = "config.json5"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-config-store-"));
  createdDirectories.push(directory);
  return join(directory, fileName);
}

describe("ConfigStore", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) {
        continue;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates a default config file when missing", async () => {
    const configPath = await createTempConfigPath();
    const store = new ConfigStore(configPath);

    const result = await store.read();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual(DEFAULT_REINS_GLOBAL_CONFIG);

    const persisted = await readFile(configPath, "utf8");
    expect(persisted.startsWith("// Reins global configuration (JSON5)\n")).toBe(true);
  });

  it("writes and reads a config roundtrip", async () => {
    const configPath = await createTempConfigPath();
    const store = new ConfigStore(configPath);

    const nextConfig: ReinsGlobalConfig = {
      ...DEFAULT_REINS_GLOBAL_CONFIG,
      activeEnvironment: "work",
      globalCredentials: {
        providerKeys: {
          openai: "rk_test_redacted",
        },
        gatewayBaseUrl: "https://gateway.example.com",
      },
      modelDefaults: {
        provider: "openai",
        model: "gpt-5",
        temperature: 0.5,
        maxTokens: 2048,
      },
      billing: {
        mode: "warn",
        monthlySoftLimitUsd: 20,
        monthlyHardLimitUsd: 40,
        currencyCode: "USD",
      },
    };

    const writeResult = await store.write(nextConfig);
    expect(writeResult.ok).toBe(true);

    const readResult = await store.read();
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) return;

    expect(readResult.value).toEqual(nextConfig);
  });

  it("fails read when config content is invalid by schema", async () => {
    const configPath = await createTempConfigPath();
    await writeFile(
      configPath,
      [
        "// Invalid schema content",
        "{",
        "  activeEnvironment: \"default\",",
        "  heartbeatIntervalMinutes: 1,",
        "}",
      ].join("\n"),
      "utf8",
    );
    const store = new ConfigStore(configPath);

    const result = await store.read();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_VALIDATION_ERROR");
    }
  });

  it("returns parse error for corrupt JSON5", async () => {
    const configPath = await createTempConfigPath();
    await writeFile(configPath, "{activeEnvironment: 'default',", "utf8");
    const store = new ConfigStore(configPath);

    const result = await store.read();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_PARSE_ERROR");
    }
  });

  it("gets and sets active environment", async () => {
    const configPath = await createTempConfigPath();
    const store = new ConfigStore(configPath);

    const setResult = await store.setActiveEnvironment("work");
    expect(setResult.ok).toBe(true);

    const getResult = await store.getActiveEnvironment();
    expect(getResult.ok).toBe(true);
    if (!getResult.ok) return;

    expect(getResult.value).toBe("work");
  });

  it("rejects invalid active environment names", async () => {
    const configPath = await createTempConfigPath();
    const store = new ConfigStore(configPath);

    const result = await store.setActiveEnvironment("INVALID NAME");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_ENVIRONMENT_NAME");
    }
  });

  it("updates scoped config sections", async () => {
    const configPath = await createTempConfigPath();
    const store = new ConfigStore(configPath);

    const updateResult = await store.updateSection("billing", {
      mode: "enforce",
      monthlySoftLimitUsd: 25,
      monthlyHardLimitUsd: 30,
      currencyCode: "USD",
    });
    expect(updateResult.ok).toBe(true);

    const readResult = await store.read();
    expect(readResult.ok).toBe(true);
    if (!readResult.ok) return;

    expect(readResult.value.billing.mode).toBe("enforce");
    expect(readResult.value.billing.monthlyHardLimitUsd).toBe(30);
  });

  it("returns read error when file is missing and creation disabled", async () => {
    const configPath = await createTempConfigPath();
    const store = new ConfigStore(configPath, { createIfMissing: false });

    const result = await store.read();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CONFIG_READ_ERROR");
    }
  });
});
