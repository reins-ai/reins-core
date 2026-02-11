#!/usr/bin/env bun

import { launchTui, type LaunchTuiFn } from "./launch-tui";
import { runOneshot, type OneshotOptions } from "./commands/oneshot";
import { runService, type RunServiceFn } from "./commands/service";
import { runStatus, type RunStatusFn } from "./commands/status";
import { runSetup, type RunSetupFn } from "./commands/setup";

type WriteFn = (text: string) => void;
type RunOneshotFn = (query: string, options?: OneshotOptions) => Promise<number>;

type CliCommand = "setup" | "status" | "service";

type CliRoute =
  | { kind: "launch-tui" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "command"; command: CliCommand; args: string[] }
  | { kind: "oneshot"; query: string; options: OneshotOptions };

export interface CliRuntimeDeps {
  version: string;
  launchTui: LaunchTuiFn;
  runOneshot: RunOneshotFn;
  runStatus: RunStatusFn;
  runService: RunServiceFn;
  runSetup: RunSetupFn;
  writeStdout: WriteFn;
  writeStderr: WriteFn;
}

const KNOWN_COMMANDS = new Set<CliCommand>(["setup", "status", "service"]);
const DEFAULT_VERSION = "0.1.0";

interface ParsedOneshotArgs {
  query: string;
  options: OneshotOptions;
}

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
    "  reins [--model <model>] [--timeout <seconds>] [--no-stream] \"your question\"",
    "  reins \"your question\"",
    "",
    "Commands:",
    "  setup      Run interactive setup",
    "  status     Show daemon and provider status",
    "  service    Manage daemon lifecycle",
    "  help       Show this help",
    "  -h, --help Show this help",
    "  -v, --version Show version",
    "",
    "One-shot options:",
    "  --model <model> Set model override for this query",
    "  --timeout <seconds> Set request timeout (default: 60)",
    "  --no-stream Buffer full response before printing",
  ].join("\n");
}

function parseOneshotArgs(args: string[]): ParsedOneshotArgs | null {
  const queryTokens: string[] = [];
  const options: OneshotOptions = {};

  let index = 0;
  let parsingFlags = true;

  while (index < args.length) {
    const token = args[index];

    if (parsingFlags && token === "--model") {
      const model = args[index + 1];
      if (typeof model !== "string" || model.length === 0) {
        return null;
      }

      options.model = model;
      index += 2;
      continue;
    }

    if (parsingFlags && token === "--timeout") {
      const timeoutValue = args[index + 1];
      const parsedTimeout = Number(timeoutValue);
      if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
        return null;
      }

      options.timeoutSeconds = parsedTimeout;
      index += 2;
      continue;
    }

    if (parsingFlags && token === "--no-stream") {
      options.stream = false;
      index += 1;
      continue;
    }

    if (parsingFlags && token.startsWith("-")) {
      return null;
    }

    parsingFlags = false;
    queryTokens.push(token);
    index += 1;
  }

  if (queryTokens.length === 0) {
    return null;
  }

  return {
    query: queryTokens.join(" "),
    options,
  };
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

  const parsedOneshot = parseOneshotArgs(args);
  if (!parsedOneshot) {
    return { kind: "launch-tui" };
  }

  return { kind: "oneshot", query: parsedOneshot.query, options: parsedOneshot.options };
}

export async function runCli(args: string[], customDeps: Partial<CliRuntimeDeps> = {}): Promise<number> {
  const deps: CliRuntimeDeps = {
    version: customDeps.version ?? DEFAULT_VERSION,
    launchTui: customDeps.launchTui ?? launchTui,
    runOneshot: customDeps.runOneshot ?? runOneshot,
    runStatus: customDeps.runStatus ?? runStatus,
    runService: customDeps.runService ?? runService,
    runSetup: customDeps.runSetup ?? runSetup,
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
        if (route.command === "setup") {
          return deps.runSetup(route.args);
        }

        if (route.command === "status") {
          return deps.runStatus(route.args, {
            writeStdout: deps.writeStdout,
            writeStderr: deps.writeStderr,
          });
        }

        if (route.command === "service") {
          const [action] = route.args;
          return deps.runService(action ?? "", {
            writeStdout: deps.writeStdout,
            writeStderr: deps.writeStderr,
          });
        }

        deps.writeStdout(`${brand(deps.version)} | ${route.command} command is coming soon\n`);
        if (route.args.length > 0) {
          deps.writeStdout(`Received arguments: ${route.args.join(" ")}\n`);
        }
        return 0;
      }
      case "oneshot": {
        return deps.runOneshot(route.query, route.options);
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
