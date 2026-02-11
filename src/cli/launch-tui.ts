import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type WriteFn = (text: string) => void;

type SpawnFn = typeof Bun.spawn;

export interface LaunchTuiOptions {
  version: string;
  writeStdout?: WriteFn;
  writeStderr?: WriteFn;
  spawn?: SpawnFn;
  signalProcess?: NodeJS.Process;
}

export type LaunchTuiFn = (options: LaunchTuiOptions) => Promise<number>;

export function formatBootBanner(version: string): string {
  return `reins v${version} | launching TUI`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolveTuiEntrypoint(): Promise<string | null> {
  const cliDirectory = dirname(fileURLToPath(import.meta.url));
  const coreRoot = resolve(cliDirectory, "..", "..");
  const repositoryRoot = resolve(coreRoot, "..");

  const candidates = [
    process.env.REINS_TUI_ENTRY,
    resolve(repositoryRoot, "reins-tui", "src", "index.tsx"),
    resolve(coreRoot, "node_modules", "@reins", "tui", "src", "index.tsx"),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function launchTui(options: LaunchTuiOptions): Promise<number> {
  const writeStdout = options.writeStdout ?? process.stdout.write.bind(process.stdout);
  const writeStderr = options.writeStderr ?? process.stderr.write.bind(process.stderr);
  const spawn = options.spawn ?? Bun.spawn;
  const signalProcess = options.signalProcess ?? process;

  writeStdout(`${formatBootBanner(options.version)}\n`);

  const tuiEntrypoint = await resolveTuiEntrypoint();
  if (!tuiEntrypoint) {
    writeStderr("[reins] Unable to locate reins-tui entrypoint.\n");
    return 1;
  }

  try {
    const child = spawn([process.execPath, "run", tuiEntrypoint], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });

    const forwardSignal = (signal: NodeJS.Signals): void => {
      child.kill(signal);
    };

    signalProcess.on("SIGINT", forwardSignal);
    signalProcess.on("SIGTERM", forwardSignal);

    try {
      return await child.exited;
    } finally {
      signalProcess.off("SIGINT", forwardSignal);
      signalProcess.off("SIGTERM", forwardSignal);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown launch failure";
    writeStderr(`[reins] Failed to launch TUI: ${message}\n`);
    return 1;
  }
}
