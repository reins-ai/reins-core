import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

import { err, ok, type Result } from "../result";
import { DaemonError } from "./types";

const DATA_DIRECTORY_MODE = 0o700;

export interface DaemonPaths {
  dataRoot: string;
  sessionsDir: string;
  transcriptsDir: string;
  cronDir: string;
  gatewayDir: string;
  logsDir: string;
}

export interface DaemonPathOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

type DaemonPathResult<T> = Result<T, DaemonError>;

export function getDataRoot(options: DaemonPathOptions = {}): string {
  return buildDaemonPaths(options).dataRoot;
}

export function getSessionsDir(options: DaemonPathOptions = {}): string {
  return buildDaemonPaths(options).sessionsDir;
}

export function getTranscriptsDir(options: DaemonPathOptions = {}): string {
  return buildDaemonPaths(options).transcriptsDir;
}

export function getCronDir(options: DaemonPathOptions = {}): string {
  return buildDaemonPaths(options).cronDir;
}

export function getGatewayDir(options: DaemonPathOptions = {}): string {
  return buildDaemonPaths(options).gatewayDir;
}

export function getLogsDir(options: DaemonPathOptions = {}): string {
  return buildDaemonPaths(options).logsDir;
}

export async function ensureDataDirectories(options: DaemonPathOptions = {}): Promise<DaemonPathResult<DaemonPaths>> {
  const paths = buildDaemonPaths(options);
  const platform = options.platform ?? process.platform;
  const directories = [
    paths.dataRoot,
    paths.sessionsDir,
    paths.transcriptsDir,
    paths.cronDir,
    paths.gatewayDir,
    paths.logsDir,
  ];

  try {
    for (const directory of directories) {
      await createDirectory(directory, platform);
    }

    return ok(paths);
  } catch (error) {
    return err(
      new DaemonError(
        "Failed to initialize daemon data directories",
        "DAEMON_DIRECTORY_INIT_FAILED",
        error instanceof Error ? error : undefined,
      ),
    );
  }
}

function buildDaemonPaths(options: DaemonPathOptions): DaemonPaths {
  const platform = options.platform ?? process.platform;
  const dataRoot = resolveDataRoot(options);

  return {
    dataRoot,
    sessionsDir: platformJoin(platform, dataRoot, "sessions"),
    transcriptsDir: platformJoin(platform, dataRoot, "transcripts"),
    cronDir: platformJoin(platform, dataRoot, "cron"),
    gatewayDir: platformJoin(platform, dataRoot, "gateway"),
    logsDir: platformJoin(platform, dataRoot, "logs"),
  };
}

function resolveDataRoot(options: DaemonPathOptions): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDirectory = options.homeDirectory ?? homedir();

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

function platformJoin(platform: NodeJS.Platform, ...segments: string[]): string {
  return platform === "win32" ? win32.join(...segments) : join(...segments);
}

async function createDirectory(path: string, platform: NodeJS.Platform): Promise<void> {
  await mkdir(path, { recursive: true, mode: DATA_DIRECTORY_MODE });

  if (platform !== "win32") {
    await chmod(path, DATA_DIRECTORY_MODE);
  }
}
