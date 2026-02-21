import { spawn } from "node:child_process";
import { join } from "node:path";

import { createLogger } from "../logger";
import { err, ok, type Result } from "../result";

const log = createLogger("skills:runner");
import { SkillError, SKILL_ERROR_CODES } from "./errors";
import {
  AutoDenyPermissionChecker,
  SkillPermissionPolicy,
  type SkillPermissionChecker,
} from "./permissions";
import type { SkillRegistry } from "./registry";

export interface ScriptResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
}

export interface ScriptRunnerOptions {
  timeout?: number;
  env?: Record<string, string>;
  cwd?: string;
  signal?: AbortSignal;
}

interface ScriptRunnerConfig {
  defaultTimeout?: number;
  permissionChecker?: SkillPermissionChecker;
}

export class ScriptRunner {
  private readonly registry: SkillRegistry;
  private readonly defaultTimeout: number;
  private readonly permissionPolicy: SkillPermissionPolicy;

  constructor(registry: SkillRegistry, options?: ScriptRunnerConfig) {
    this.registry = registry;
    this.defaultTimeout = options?.defaultTimeout ?? 30_000;
    this.permissionPolicy = new SkillPermissionPolicy(
      options?.permissionChecker ?? new AutoDenyPermissionChecker(),
    );
  }

  async execute(
    skillName: string,
    scriptName: string,
    options?: ScriptRunnerOptions,
  ): Promise<Result<ScriptResult, SkillError>> {
    const skill = this.registry.get(skillName);
    if (!skill) {
      return err(new SkillError(`Skill not found: ${skillName}`));
    }

    if (!skill.hasScripts || !skill.scriptFiles.includes(scriptName)) {
      return err(new SkillError(`Script "${scriptName}" not found in skill "${skillName}"`));
    }

    const permissionResult = await this.permissionPolicy.checkPermission(skill, scriptName);
    if (permissionResult === "denied") {
      const permissionError = new SkillError(
        `Permission denied to execute script "${scriptName}" for skill "${skillName}"`,
      );
      permissionError.code = SKILL_ERROR_CODES.PERMISSION;
      return err(permissionError);
    }

    const timeoutMs = options?.timeout ?? this.defaultTimeout;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return err(new SkillError(`Invalid timeout: ${timeoutMs}`));
    }

    const scriptPath = join(skill.config.path, "scripts", scriptName);
    const cwd = options?.cwd ?? skill.config.path;
    const env = { ...process.env, ...options?.env };

    const startedAt = Date.now();
    let timedOut = false;

    try {
      const child = spawn("bash", [scriptPath], {
        cwd,
        env,
        detached: true,
        signal: options?.signal,
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: Buffer | string) => {
        stdout += chunk.toString();
      });

      child.stderr?.on("data", (chunk: Buffer | string) => {
        stderr += chunk.toString();
      });

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const closePromise = new Promise<number | null>((resolve, reject) => {
        child.once("error", (error) => {
          reject(error);
        });

        child.once("close", (code) => {
          resolve(code);
        });
      });

      const timeoutPromise = new Promise<"timeout">((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          this.terminateProcess(child.pid);
          resolve("timeout");
        }, timeoutMs);
      });

      const racedResult = await Promise.race([
        closePromise.then((exitCode) => ({ kind: "close" as const, exitCode })),
        timeoutPromise.then(() => ({ kind: "timeout" as const })),
      ]);

      const exitCode =
        racedResult.kind === "close" ? racedResult.exitCode : await closePromise;

      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      return ok({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(new SkillError(`Failed to execute script "${scriptName}": ${message}`));
    }
  }

  private terminateProcess(pid: number | undefined): void {
    if (!pid) {
      return;
    }

    try {
      process.kill(-pid, "SIGTERM");
    } catch (e) {
      // Expected: process group may not exist — fall back to direct kill
      log.debug("process group kill failed, trying direct kill", { pid, error: e instanceof Error ? e.message : String(e) });
      try {
        process.kill(pid, "SIGTERM");
      } catch (e2) {
        // Expected: process may have already exited
        log.debug("direct process kill failed", { pid, error: e2 instanceof Error ? e2.message : String(e2) });
      }
    }
  }
}
