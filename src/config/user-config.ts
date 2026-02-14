import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, win32 } from "node:path";

import { getDataRoot } from "../daemon/paths";
import { err, ok, type Result } from "../result";

const DEFAULT_DAEMON_HOST = "localhost";
const DEFAULT_DAEMON_PORT = 7433;

export type UserProviderMode = "byok" | "gateway" | "none";

export type SearchProviderPreference = "exa" | "brave";

export interface UserConfig {
  name: string;
  provider: {
    mode: UserProviderMode;
    activeProvider?: string;
    search?: {
      provider: SearchProviderPreference;
    };
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
  return getDataRoot(options);
}

export function resolveUserConfigPath(options: UserConfigPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const configDir = resolveUserConfigDirectory(options);
  return platform === "win32" ? win32.join(configDir, "config.json") : join(configDir, "config.json");
}

/**
 * Resolves the legacy config path (~/.config/reins/config.json) for migration fallback.
 * Used to read config from the old location if it doesn't exist at the new data root.
 */
function resolveLegacyConfigPath(options: UserConfigPathOptions = {}): string {
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

  const legacyDir = platform === "win32" ? win32.join(configRoot, "reins") : join(configRoot, "reins");
  return platform === "win32" ? win32.join(legacyDir, "config.json") : join(legacyDir, "config.json");
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

function normalizeSearchProviderPreference(value: unknown): SearchProviderPreference {
  if (value === "exa" || value === "brave") {
    return value;
  }

  return "brave";
}

function normalizeConfig(value: unknown): UserConfig {
  if (!isRecord(value)) {
    return {
      name: "",
      provider: { mode: "none", search: { provider: "brave" } },
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
  const searchCandidate = isRecord(providerCandidate.search) ? providerCandidate.search : {};
  const searchProvider = normalizeSearchProviderPreference(searchCandidate.provider);

  return {
    name: typeof value.name === "string" ? value.name : "",
    provider: {
      mode,
      activeProvider,
      search: {
        provider: searchProvider,
      },
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
  const nextSearchProvider = normalizeSearchProviderPreference(
    updates.provider?.search?.provider ?? base.provider.search?.provider ?? "brave",
  );

  return {
    name: updates.name ?? base.name,
    provider: {
      mode: nextProviderMode,
      activeProvider: nextActiveProvider,
      search: {
        provider: nextSearchProvider,
      },
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
    // Migration fallback: check legacy ~/.config/reins/config.json
    if (!options.filePath) {
      const legacyPath = resolveLegacyConfigPath(options);
      const legacyFile = Bun.file(legacyPath);

      if (await legacyFile.exists()) {
        try {
          const raw = await legacyFile.json();
          return ok(normalizeConfig(raw));
        } catch {
          // Legacy file is corrupt — treat as no config
          return ok(null);
        }
      }
    }

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
