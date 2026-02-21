import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import { createLogger } from "../../logger";
import { BASH_DEFINITION } from "../builtins";

const log = createLogger("tools:bash");
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../../types";
import { validateCommand } from "./command-policy";
import { validatePath } from "./sandbox";
import { truncateOutput } from "./truncation";
import {
  SystemToolExecutionError,
  type SystemToolDefinition,
  type SystemToolResult,
} from "./types";

const DEFAULT_TIMEOUT_MS = 90_000;
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const ABORT_KILL_GRACE_MS = 150;
const FALLBACK_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

type BashToolDefinition = SystemToolDefinition & ToolDefinition;

export class BashTool implements Tool {
  readonly definition: BashToolDefinition;

  constructor(private readonly sandboxRoot: string) {
    this.definition = {
      ...BASH_DEFINITION,
      parameters: BASH_DEFINITION.input_schema,
    };
  }

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const command = this.readRequiredCommand(args);
    const timeoutMs = this.readTimeoutMs(args);
    const workdir = this.readWorkdir(args);

    const commandValidation = validateCommand(command);
    if (!commandValidation.ok) {
      throw commandValidation.error;
    }

    const pathValidation = validatePath(workdir ?? ".", this.sandboxRoot);
    if (!pathValidation.ok) {
      throw pathValidation.error;
    }

    const cwd = pathValidation.value;

    if (context.abortSignal?.aborted) {
      throw SystemToolExecutionError.failed("Tool execution aborted", {
        details: {
          command,
          workdir: cwd,
          reason: "abort_signal",
        },
      });
    }

    const execution = await runCommand({
      command,
      cwd,
      timeoutMs,
      abortSignal: context.abortSignal,
    });

    const output = `${execution.stdout}${execution.stderr}`;
    const truncated = truncateOutput(output);

    const systemResult: SystemToolResult = {
      title: `Executed command: ${command}`,
      output: truncated.output,
      metadata: {
        truncated: truncated.metadata.truncated,
        lineCount: truncated.metadata.originalLines,
        byteCount: truncated.metadata.originalBytes,
        command,
        workdir: cwd,
        timeoutMs,
        ...(execution.aborted ? { aborted: true } : {}),
      },
    };

    if (execution.aborted) {
      return {
        callId: "system-bash",
        name: this.definition.name,
        result: systemResult,
        error: "Tool execution aborted",
      };
    }

    if (execution.timedOut) {
      throw SystemToolExecutionError.timeout(timeoutMs);
    }

    if (execution.exitCode !== 0) {
      const details: Record<string, unknown> = {
        command,
        workdir: cwd,
        exitCode: execution.exitCode,
        signal: execution.signal,
      };

      if (execution.stdout.length > 0) {
        details["stdout"] = execution.stdout;
      }
      if (execution.stderr.length > 0) {
        details["stderr"] = execution.stderr;
      }

      throw SystemToolExecutionError.failed(
        `Command failed with exit code ${execution.exitCode}`,
        {
          details,
        },
      );
    }

    return {
      callId: "system-bash",
      name: this.definition.name,
      result: systemResult,
    };
  }

  private readRequiredCommand(args: Record<string, unknown>): string {
    const command = args["command"];
    if (typeof command !== "string") {
      throw SystemToolExecutionError.validation("Invalid command argument", {
        expected: "string",
        receivedType: typeof command,
      });
    }

    return command;
  }

  private readWorkdir(args: Record<string, unknown>): string | undefined {
    const value = args["workdir"];
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "string") {
      throw SystemToolExecutionError.validation("Invalid workdir argument", {
        expected: "string",
        receivedType: typeof value,
      });
    }

    return value;
  }

  private readTimeoutMs(args: Record<string, unknown>): number {
    const value = args["timeout"];
    if (value === undefined) {
      return DEFAULT_TIMEOUT_MS;
    }

    if (!isFiniteNumber(value) || value <= 0) {
      throw SystemToolExecutionError.validation("Invalid timeout argument", {
        expected: "positive number",
        received: value,
      });
    }

    return Math.floor(value);
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function prependPathEntry(pathValue: string, entry: string): string {
  if (entry.length === 0) {
    return pathValue;
  }

  const segments = pathValue.split(delimiter).filter((segment) => segment.length > 0);
  if (segments.includes(entry)) {
    return pathValue;
  }

  return [entry, ...segments].join(delimiter);
}

export function buildExecutionEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  const home = (env.HOME && env.HOME.trim().length > 0)
    ? env.HOME
    : (env.USERPROFILE && env.USERPROFILE.trim().length > 0)
      ? env.USERPROFILE
      : homedir();

  env.HOME = home;
  if (!env.USERPROFILE || env.USERPROFILE.trim().length === 0) {
    env.USERPROFILE = home;
  }
  if (!env.XDG_CONFIG_HOME || env.XDG_CONFIG_HOME.trim().length === 0) {
    env.XDG_CONFIG_HOME = join(home, ".config");
  }
  if (!env.XDG_CACHE_HOME || env.XDG_CACHE_HOME.trim().length === 0) {
    env.XDG_CACHE_HOME = join(home, ".cache");
  }
  if (!env.XDG_DATA_HOME || env.XDG_DATA_HOME.trim().length === 0) {
    env.XDG_DATA_HOME = join(home, ".local", "share");
  }

  const basePath = env.PATH && env.PATH.trim().length > 0
    ? env.PATH
    : FALLBACK_PATH;
  env.PATH = prependPathEntry(basePath, join(home, ".local", "bin"));

  return env;
}


async function runCommand(options: {
  command: string;
  cwd: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<{
  exitCode: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
}> {
  // Use setsid to make the shell a new process group leader so that
  // process.kill(-pid, signal) terminates the entire group (background children included).
  const child = spawn("setsid", ["/bin/sh", "-c", options.command], {
    cwd: options.cwd,
    env: buildExecutionEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let aborted = false;
  let timedOut = false;
  let settled = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

  const appendChunk = (current: string, chunk: Buffer): string => {
    if (current.length >= MAX_BUFFER_BYTES) {
      return current;
    }
    const remaining = MAX_BUFFER_BYTES - current.length;
    const s = chunk.toString("utf8");
    return current + (s.length <= remaining ? s : s.slice(0, remaining));
  };

  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendChunk(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendChunk(stderr, chunk);
  });

  const killProcessGroup = (sig: NodeJS.Signals): void => {
    if (child.pid) {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch (e) {
        // Expected: process group not found or already exited — fall through to direct kill
        log.debug("process group kill failed", { pid: child.pid, signal: sig, error: e instanceof Error ? e.message : String(e) });
      }
    }
    try {
      child.kill(sig);
    } catch {
      // Expected: child already exited
    }
  };

  const terminateProcess = (mode: "abort" | "timeout"): void => {
    if (mode === "abort") {
      aborted = true;
    } else {
      timedOut = true;
    }

    if (!child.killed) {
      killProcessGroup("SIGTERM");
    }

    if (!killTimer) {
      killTimer = setTimeout(() => {
        if (!settled) {
          killProcessGroup("SIGKILL");
        }
      }, ABORT_KILL_GRACE_MS);
    }
  };

  if (options.timeoutMs > 0) {
    timeoutTimer = setTimeout(() => {
      terminateProcess("timeout");
    }, options.timeoutMs);
  }

  const abortListener = () => {
    terminateProcess("abort");
  };
  options.abortSignal?.addEventListener("abort", abortListener, { once: true });
  if (options.abortSignal?.aborted) {
    terminateProcess("abort");
  }

  return await new Promise((resolve, reject) => {
    child.once("error", (error) => {
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.abortSignal?.removeEventListener("abort", abortListener);
      reject(error);
    });

    child.once("close", (code, signal) => {
      settled = true;

      if (options.abortSignal?.aborted && !timedOut) {
        aborted = true;
      }

      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      options.abortSignal?.removeEventListener("abort", abortListener);

      resolve({
        exitCode: code ?? 0,
        signal,
        stdout,
        stderr,
        aborted,
        timedOut,
      });
    });
  });
}
