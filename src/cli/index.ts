#!/usr/bin/env bun

import { launchTui, type LaunchTuiFn } from "./launch-tui";

type WriteFn = (text: string) => void;

type CliCommand = "setup" | "status" | "service";

type CliRoute =
  | { kind: "launch-tui" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "command"; command: CliCommand; args: string[] }
  | { kind: "oneshot"; query: string };

export interface CliRuntimeDeps {
  version: string;
  launchTui: LaunchTuiFn;
  writeStdout: WriteFn;
  writeStderr: WriteFn;
}

const KNOWN_COMMANDS = new Set<CliCommand>(["setup", "status", "service"]);
const DEFAULT_VERSION = "0.1.0";

function isKnownCommand(command: string): command is CliCommand {
  return KNOWN_COMMANDS.has(command as CliCommand);
}

function brand(version: string): string {
  return `reins v${version}`;
}

export function buildHelpText(version: string): string {
  return [
    `${brand(version)}`,
    "",
    "Usage:",
    "  reins [command]",
    "  reins \"your question\"",
    "",
    "Commands:",
    "  setup      Run interactive setup (coming soon)",
    "  status     Show daemon and provider status (coming soon)",
    "  service    Manage daemon lifecycle (coming soon)",
    "  help       Show this help",
    "  -h, --help Show this help",
    "  -v, --version Show version",
  ].join("\n");
}

export function routeCliArgs(args: string[]): CliRoute {
  if (args.length === 0) {
    return { kind: "launch-tui" };
  }

  const [first, ...rest] = args;

  if (first === "help" || first === "--help" || first === "-h") {
    return { kind: "help" };
  }

  if (first === "--version" || first === "-v") {
    return { kind: "version" };
  }

  if (isKnownCommand(first)) {
    return { kind: "command", command: first, args: rest };
  }

  if (first.startsWith("-")) {
    return { kind: "launch-tui" };
  }

  return { kind: "oneshot", query: args.join(" ") };
}

export async function runCli(args: string[], customDeps: Partial<CliRuntimeDeps> = {}): Promise<number> {
  const deps: CliRuntimeDeps = {
    version: customDeps.version ?? DEFAULT_VERSION,
    launchTui: customDeps.launchTui ?? launchTui,
    writeStdout: customDeps.writeStdout ?? process.stdout.write.bind(process.stdout),
    writeStderr: customDeps.writeStderr ?? process.stderr.write.bind(process.stderr),
  };

  const route = routeCliArgs(args);

  try {
    switch (route.kind) {
      case "help": {
        deps.writeStdout(`${buildHelpText(deps.version)}\n`);
        return 0;
      }
      case "version": {
        deps.writeStdout(`${brand(deps.version)}\n`);
        return 0;
      }
      case "command": {
        deps.writeStdout(`${brand(deps.version)} | ${route.command} command is coming soon\n`);
        if (route.args.length > 0) {
          deps.writeStdout(`Received arguments: ${route.args.join(" ")}\n`);
        }
        return 0;
      }
      case "oneshot": {
        deps.writeStdout(`${brand(deps.version)} | one-shot mode is coming soon\n`);
        deps.writeStdout(`Query: ${route.query}\n`);
        return 0;
      }
      case "launch-tui":
      default:
        return deps.launchTui({
          version: deps.version,
          writeStdout: deps.writeStdout,
          writeStderr: deps.writeStderr,
        });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    deps.writeStderr(`[reins] CLI error: ${message}\n`);
    return 1;
  }
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exit(exitCode);
  });
}
