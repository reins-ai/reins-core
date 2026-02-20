import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

import { err, ok, type Result } from "../result";
import type { DaemonPathOptions } from "../daemon/paths";
import type { PersonalityPreset } from "../onboarding/types";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  type ReinsGlobalConfig,
} from "../config/format-decision";
import { EnvironmentBootstrapFailedError } from "./errors";
import { getAllTemplates } from "./templates";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const CONFIG_FILE_NAME = "config.json5";

export interface InstallPaths {
  installRoot: string;
  environmentsDir: string;
  defaultEnvironmentDir: string;
  globalConfigPath: string;
}

export interface BootstrapResult {
  paths: InstallPaths;
  configCreated: boolean;
  directoriesCreated: string[];
}

export interface BootstrapOptions extends DaemonPathOptions {
  /** Personality preset to use when generating PERSONALITY.md for new environments. */
  personalityPreset?: PersonalityPreset;
  /** Custom instructions for the "custom" personality preset. */
  customInstructions?: string;
}

/**
 * Resolve the install root path for the current platform.
 *
 * Uses the same platform logic as daemon paths:
 * - Linux: ~/.reins/
 * - macOS: ~/Library/Application Support/reins/
 * - Windows: %APPDATA%\reins\
 */
export function resolveInstallRoot(options: DaemonPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homeDir();

  if (platform === "darwin") {
    return platformJoin(platform, homeDirectory, "Library", "Application Support", "reins");
  }

  if (platform === "win32") {
    const appData = env.APPDATA ?? platformJoin(platform, homeDirectory, "AppData", "Roaming");
    return platformJoin(platform, appData, "reins");
  }

  if (platform === "linux") {
    return platformJoin(platform, homeDirectory, ".reins");
  }

  return platformJoin(platform, homeDirectory, ".reins");
}

/**
 * Build the full set of install paths from the resolved root.
 */
export function buildInstallPaths(options: DaemonPathOptions = {}): InstallPaths {
  const platform = options.platform ?? process.platform;
  const installRoot = resolveInstallRoot(options);

  return {
    installRoot,
    environmentsDir: platformJoin(platform, installRoot, "environments"),
    defaultEnvironmentDir: platformJoin(platform, installRoot, "environments", "default"),
    globalConfigPath: platformJoin(platform, installRoot, CONFIG_FILE_NAME),
  };
}

/**
 * Bootstrap the install root directory structure and default config file.
 *
 * This operation is idempotent: running it multiple times produces the same
 * directory tree and does not overwrite an existing config file.
 *
 * Creates:
 * - Install root directory
 * - environments/ subdirectory
 * - environments/default/ subdirectory
 * - Global config file (config.json5) with default values if absent
 */
export async function bootstrapInstallRoot(
  options: BootstrapOptions = {},
): Promise<Result<BootstrapResult, EnvironmentBootstrapFailedError>> {
  const platform = options.platform ?? process.platform;
  const paths = buildInstallPaths(options);

  const directories = [
    paths.installRoot,
    paths.environmentsDir,
    paths.defaultEnvironmentDir,
  ];

  const directoriesCreated: string[] = [];

  try {
    for (const directory of directories) {
      const created = await ensureDirectory(directory, platform);
      if (created) {
        directoriesCreated.push(directory);
      }
    }

    const configCreated = await ensureDefaultConfig(paths.globalConfigPath, platform);
    await ensureDefaultEnvironmentDocuments(
      paths.defaultEnvironmentDir,
      platform,
      options.personalityPreset,
      options.customInstructions,
    );

    return ok({
      paths,
      configCreated,
      directoriesCreated,
    });
  } catch (error) {
    return err(
      new EnvironmentBootstrapFailedError(
        "Failed to bootstrap install root",
        error instanceof Error ? error : undefined,
      ),
    );
  }
}

/**
 * Generate the default global config content as a JSON5 string.
 *
 * The output is valid JSON (a strict subset of JSON5) with a leading
 * comment indicating the format. This avoids requiring a JSON5 serializer
 * at bootstrap time while remaining parseable by JSON5 readers.
 */
export function generateDefaultConfigContent(): string {
  const config: ReinsGlobalConfig = {
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

  return `// Reins global configuration (JSON5)\n${JSON.stringify(config, null, 2)}\n`;
}

async function ensureDirectory(path: string, platform: NodeJS.Platform): Promise<boolean> {
  const existed = await directoryExists(path);

  await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });

  if (platform !== "win32") {
    await chmod(path, DIRECTORY_MODE);
  }

  return !existed;
}

async function ensureDefaultConfig(configPath: string, platform: NodeJS.Platform): Promise<boolean> {
  if (await fileExists(configPath)) {
    return false;
  }

  const content = generateDefaultConfigContent();
  await writeFile(configPath, content, { encoding: "utf8", mode: FILE_MODE });

  if (platform !== "win32") {
    await chmod(configPath, FILE_MODE);
  }

  return true;
}

/**
 * Ensure all required environment documents exist in the given directory.
 *
 * This is safe to call on any environment directory (default or named).
 * Existing files are never overwritten — only missing documents are created.
 * When a `personalityPreset` is provided, PERSONALITY.md is generated
 * using that preset instead of the static template.
 *
 * This operation is idempotent: calling it twice produces the same result.
 */
export async function bootstrapEnvironmentDocuments(
  envDir: string,
  options?: BootstrapOptions,
): Promise<void> {
  const platform = options?.platform ?? process.platform;
  const templates = getAllTemplates(
    options?.personalityPreset
      ? { personalityPreset: options.personalityPreset, customInstructions: options.customInstructions }
      : undefined,
  );

  await mkdir(envDir, { recursive: true });

  for (const [name, content] of templates) {
    const documentPath = platformJoin(platform, envDir, name);
    if (await fileExists(documentPath)) {
      continue;
    }

    await writeFile(documentPath, content, { encoding: "utf8", mode: FILE_MODE });
    if (platform !== "win32") {
      await chmod(documentPath, FILE_MODE);
    }
  }
}

async function ensureDefaultEnvironmentDocuments(
  defaultEnvironmentDir: string,
  platform: NodeJS.Platform,
  personalityPreset?: PersonalityPreset,
  customInstructions?: string,
): Promise<void> {
  await bootstrapEnvironmentDocuments(defaultEnvironmentDir, {
    platform,
    personalityPreset,
    customInstructions,
  });
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

function platformJoin(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === "win32" ? win32.join(...segments) : join(...segments);
}

function homeDir(): string {
  return homedir();
}
