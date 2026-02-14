import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

import { err, ok, type Result } from "../result";
import type { DaemonPathOptions } from "../daemon/paths";
import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_HEARTBEAT_INTERVAL_MINUTES,
  type ReinsGlobalConfig,
} from "../config/format-decision";
import { EnvironmentBootstrapFailedError } from "./errors";

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

/**
 * Resolve the install root path for the current platform.
 *
 * Uses the same platform logic as daemon paths:
 * - Linux: ~/.reins/ (or $XDG_DATA_HOME/reins/)
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
    const xdgDataHome = env.XDG_DATA_HOME;
    if (xdgDataHome && xdgDataHome.trim().length > 0) {
      return platformJoin(platform, xdgDataHome, "reins");
    }

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
  options: DaemonPathOptions = {},
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
