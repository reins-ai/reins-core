import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";

import { err, ok, type Result } from "../result";

const DEFAULT_DAEMON_HOST = "localhost";
const DEFAULT_DAEMON_PORT = 7433;

export type UserProviderMode = "byok" | "gateway" | "none";

export interface UserConfig {
  name: string;
  provider: {
    mode: UserProviderMode;
    activeProvider?: string;
  };
  daemon: {
    host: string;
    port: number;
  };
  setupComplete: boolean;
}

export interface UserConfigPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

export interface UserConfigReadOptions extends UserConfigPathOptions {
  filePath?: string;
}

export interface UserConfigWriteOptions extends UserConfigPathOptions {
  filePath?: string;
}

export class UserConfigError extends Error {
  constructor(message: string, readonly cause?: Error) {
    super(message);
    this.name = "UserConfigError";
  }
}

export function resolveUserConfigDirectory(options: UserConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();

  const xdgConfigHome = env.XDG_CONFIG_HOME;
  const configRoot =
    xdgConfigHome && xdgConfigHome.trim().length > 0
      ? xdgConfigHome
      : platform === "win32"
        ? win32.join(homeDirectory, ".config")
        : join(homeDirectory, ".config");

  return platform === "win32" ? win32.join(configRoot, "reins") : join(configRoot, "reins");
}

export function resolveUserConfigPath(options: UserConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const configDir = resolveUserConfigDirectory(options);
  return platform === "win32" ? win32.join(configDir, "config.json") : join(configDir, "config.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeProviderMode(value: unknown): UserProviderMode {
  if (value === "byok" || value === "gateway" || value === "none") {
    return value;
  }

  return "none";
}

function normalizeConfig(value: unknown): UserConfig {
  if (!isRecord(value)) {
    return {
      name: "",
      provider: { mode: "none" },
      daemon: { host: DEFAULT_DAEMON_HOST, port: DEFAULT_DAEMON_PORT },
      setupComplete: false,
    };
  }

  const daemonCandidate = isRecord(value.daemon) ? value.daemon : {};
  const providerCandidate = isRecord(value.provider) ? value.provider : {};
  const mode = normalizeProviderMode(providerCandidate.mode);
  const activeProvider = typeof providerCandidate.activeProvider === "string" && providerCandidate.activeProvider.trim().length > 0
    ? providerCandidate.activeProvider
    : undefined;

  return {
    name: typeof value.name === "string" ? value.name : "",
    provider: {
      mode,
      activeProvider,
    },
    daemon: {
      host: typeof daemonCandidate.host === "string" && daemonCandidate.host.length > 0
        ? daemonCandidate.host
        : DEFAULT_DAEMON_HOST,
      port: typeof daemonCandidate.port === "number" && Number.isFinite(daemonCandidate.port)
        ? daemonCandidate.port
        : DEFAULT_DAEMON_PORT,
    },
    setupComplete: value.setupComplete === true,
  };
}

function mergeUserConfig(existing: UserConfig | null, updates: Partial<UserConfig>): UserConfig {
  const base = existing ?? normalizeConfig(undefined);
  const nextProviderMode = normalizeProviderMode(updates.provider?.mode ?? base.provider.mode);
  const nextActiveProvider = updates.provider?.activeProvider ?? base.provider.activeProvider;

  return {
    name: updates.name ?? base.name,
    provider: {
      mode: nextProviderMode,
      activeProvider: nextActiveProvider,
    },
    daemon: {
      host: updates.daemon?.host ?? base.daemon.host,
      port: updates.daemon?.port ?? base.daemon.port,
    },
    setupComplete: updates.setupComplete ?? base.setupComplete,
  };
}

export async function readUserConfig(options: UserConfigReadOptions = {}): Promise<Result<UserConfig | null, UserConfigError>> {
  const filePath = options.filePath ?? resolveUserConfigPath(options);
  const file = Bun.file(filePath);

  if (!(await file.exists())) {
    return ok(null);
  }

  try {
    const raw = await file.json();
    return ok(normalizeConfig(raw));
  } catch (error) {
    return err(
      new UserConfigError(
        `Unable to parse user config: ${filePath}`,
        error instanceof Error ? error : undefined,
      ),
    );
  }
}

export async function writeUserConfig(
  updates: Partial<UserConfig>,
  options: UserConfigWriteOptions = {},
): Promise<Result<UserConfig, UserConfigError>> {
  const filePath = options.filePath ?? resolveUserConfigPath(options);

  const existingResult = await readUserConfig({ ...options, filePath });
  if (!existingResult.ok) {
    return existingResult;
  }

  const mergedConfig = mergeUserConfig(existingResult.value, updates);

  try {
    await mkdir(dirname(filePath), { recursive: true });
    await Bun.write(filePath, `${JSON.stringify(mergedConfig, null, 2)}\n`);
    return ok(mergedConfig);
  } catch (error) {
    return err(
      new UserConfigError(
        `Unable to write user config: ${filePath}`,
        error instanceof Error ? error : undefined,
      ),
    );
  }
}
