import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DetectionResult, OpenClawPlatform } from "./types";

const OPENCLAW_CONFIG_FILE = "openclaw.json";
const OPENCLAW_STATE_DIR_ENV = "OPENCLAW_STATE_DIR";

export interface OpenClawDetectorOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  fileExistsFn?: (path: string) => Promise<boolean>;
  readFileFn?: (path: string) => Promise<string | null>;
}

export class OpenClawDetector {
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDirectory: string;
  private readonly fileExistsFn: (path: string) => Promise<boolean>;
  private readonly readFileFn: (path: string) => Promise<string | null>;

  constructor(options?: OpenClawDetectorOptions) {
    this.platform = options?.platform ?? process.platform;
    this.env = options?.env ?? process.env;
    this.homeDirectory = options?.homeDirectory ?? homedir();
    this.fileExistsFn = options?.fileExistsFn ?? defaultFileExistsFn;
    this.readFileFn = options?.readFileFn ?? defaultReadFileFn;
  }

  async detect(): Promise<DetectionResult> {
    const detectedPlatform = await this.resolvePlatform();
    const envOverridePath = this.readEnvOverridePath();

    if (envOverridePath !== null) {
      return this.buildResult(detectedPlatform, envOverridePath);
    }

    const candidatePaths = this.getCandidatePaths(detectedPlatform);
    for (const candidatePath of candidatePaths) {
      if (await this.fileExistsFn(candidatePath)) {
        return this.buildResult(detectedPlatform, candidatePath);
      }
    }

    return {
      found: false,
      path: "",
      version: undefined,
      platform: detectedPlatform,
    };
  }

  private readEnvOverridePath(): string | null {
    const value = this.env[OPENCLAW_STATE_DIR_ENV];
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private async resolvePlatform(): Promise<OpenClawPlatform> {
    if (this.platform === "darwin") {
      return "macos";
    }

    if (this.platform === "win32") {
      return "windows";
    }

    if (this.platform === "linux") {
      const procVersion = await this.readFileFn("/proc/version");
      if (procVersion !== null && /microsoft/i.test(procVersion)) {
        return "wsl2";
      }

      return "linux";
    }

    return "linux";
  }

  private getCandidatePaths(platform: OpenClawPlatform): string[] {
    if (platform === "macos") {
      return [
        join(this.homeDirectory, "Library", "Application Support", "openclaw"),
        join(this.homeDirectory, ".openclaw"),
      ];
    }

    if (platform === "windows") {
      const userProfile = this.env.USERPROFILE;
      if (typeof userProfile !== "string" || userProfile.trim().length === 0) {
        return [];
      }

      return [join(userProfile, ".openclaw")];
    }

    return [join(this.homeDirectory, ".openclaw")];
  }

  private async buildResult(
    platform: OpenClawPlatform,
    openClawPath: string,
  ): Promise<DetectionResult> {
    const found = await this.fileExistsFn(openClawPath);
    if (!found) {
      return {
        found: false,
        path: "",
        version: undefined,
        platform,
      };
    }

    const version = await this.readVersion(openClawPath);

    return {
      found: true,
      path: openClawPath,
      version,
      platform,
    };
  }

  private async readVersion(openClawPath: string): Promise<string | undefined> {
    const configPath = join(openClawPath, OPENCLAW_CONFIG_FILE);
    const raw = await this.readFileFn(configPath);

    if (raw === null) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(raw) as {
        meta?: {
          lastTouchedVersion?: unknown;
        };
      };

      return typeof parsed.meta?.lastTouchedVersion === "string"
        ? parsed.meta.lastTouchedVersion
        : undefined;
    } catch {
      return undefined;
    }
  }
}

async function defaultFileExistsFn(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function defaultReadFileFn(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}
