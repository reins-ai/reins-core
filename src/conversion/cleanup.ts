import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

import { ReinsError } from "../errors";
import { err, ok, type Result } from "../result";

export interface ArchiveOptions {
  confirmed: true;
  openClawStatePath: string;
  outputDir?: string;
}

export interface UninstallOptions {
  confirmed: true;
  openClawStatePath: string;
  removeStateDir?: boolean;
}

type CleanupErrorCode =
  | "ARCHIVE_FAILED"
  | "UNINSTALL_FAILED"
  | "STATE_DELETE_FAILED"
  | "UNSAFE_PATH";

type CleanupSpawner = (command: string[]) => Promise<number>;

export interface CleanupServiceOptions {
  spawner?: CleanupSpawner;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export class CleanupError extends ReinsError {
  constructor(message: string, code: CleanupErrorCode, cause?: Error) {
    super(message, code, cause);
    this.name = "CleanupError";
  }
}

export class CleanupService {
  private readonly spawner: CleanupSpawner;
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;

  constructor(options: CleanupServiceOptions = {}) {
    this.spawner = options.spawner ?? spawnCommand;
    this.platform = options.platform ?? process.platform;
    this.homeDir = options.homeDir ?? homedir();
  }

  async archive(options: ArchiveOptions): Promise<Result<string>> {
    const timestamp = new Date().toISOString().replace(/:/g, "-").replace(/\..+/, "");
    const outputDir = options.outputDir ?? this.homeDir;
    const zipPath = join(outputDir, `openclaw-backup-${timestamp}.zip`);
    const command = this.platform === "win32"
      ? [
        "powershell",
        "-Command",
        `Compress-Archive -Path "${options.openClawStatePath}" -DestinationPath "${zipPath}"`,
      ]
      : ["zip", "-r", zipPath, options.openClawStatePath];

    try {
      const exitCode = await this.spawner(command);
      if (exitCode !== 0) {
        return err(new CleanupError("Archive failed", "ARCHIVE_FAILED"));
      }

      return ok(zipPath);
    } catch (cause) {
      return err(
        new CleanupError(
          "Archive failed",
          "ARCHIVE_FAILED",
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  async uninstall(options: UninstallOptions): Promise<Result<void>> {
    if (options.removeStateDir === true) {
      const safeToDeleteStateDir = this.isSafeToDeleteStateDir(options.openClawStatePath);
      if (!safeToDeleteStateDir) {
        return err(
          new CleanupError(
            "Refusing to remove protected Reins directory",
            "UNSAFE_PATH",
          ),
        );
      }
    }

    try {
      for (const command of this.getServiceRemovalCommands()) {
        const exitCode = await this.spawner(command);
        if (exitCode !== 0) {
          return err(new CleanupError("Failed to uninstall OpenClaw service", "UNINSTALL_FAILED"));
        }
      }

      if (options.removeStateDir === true) {
        const exitCode = await this.spawner(this.getStateDirRemovalCommand(options.openClawStatePath));
        if (exitCode !== 0) {
          return err(new CleanupError("Failed to remove OpenClaw state directory", "STATE_DELETE_FAILED"));
        }
      }

      return ok(undefined);
    } catch (cause) {
      return err(
        new CleanupError(
          "Failed to uninstall OpenClaw",
          "UNINSTALL_FAILED",
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  private getServiceRemovalCommands(): string[][] {
    if (this.platform === "darwin") {
      return [
        ["launchctl", "remove", "com.openclaw.daemon"],
        ["rm", join(this.homeDir, "Library", "LaunchAgents", "com.openclaw.daemon.plist")],
      ];
    }

    if (this.platform === "linux") {
      return [
        ["systemctl", "disable", "openclaw"],
        ["rm", "/etc/systemd/system/openclaw.service"],
      ];
    }

    return [["schtasks", "/delete", "/tn", "OpenClaw", "/f"]];
  }

  private getStateDirRemovalCommand(openClawStatePath: string): string[] {
    if (this.platform === "win32") {
      return [
        "powershell",
        "-Command",
        `Remove-Item -LiteralPath "${openClawStatePath}" -Recurse -Force`,
      ];
    }

    return ["rm", "-rf", openClawStatePath];
  }

  private isSafeToDeleteStateDir(openClawStatePath: string): boolean {
    const normalizedStatePath = resolve(openClawStatePath);
    const reinsRoot = resolve(this.homeDir, ".reins");

    if (normalizedStatePath === reinsRoot) {
      return false;
    }

    return !normalizedStatePath.startsWith(`${reinsRoot}${sep}`);
  }
}

async function spawnCommand(command: string[]): Promise<number> {
  const proc = Bun.spawn(command, {
    stdout: "ignore",
    stderr: "ignore",
  });
  await proc.exited;
  return proc.exitCode ?? -1;
}
