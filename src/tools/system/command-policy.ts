import { err, ok, type Result } from "../../result";
import { SystemToolExecutionError } from "./types";

export const BANNED_COMMANDS = [
  "rm -rf /",
  "rm -fr /",
  "sudo",
  "su",
  "mkfs",
  "dd if=",
  "shutdown",
  "reboot",
  ":(){ :|:& };:",
  "chmod -r 777 /",
  "chown -r /",
];

export function validateCommand(command: string): Result<void, SystemToolExecutionError> {
  const normalizedCommand = command.trim();
  if (normalizedCommand.length === 0) {
    return err(
      SystemToolExecutionError.validation("Command cannot be empty", {
        command,
        reason: "empty_command",
      }),
    );
  }

  const matchedPattern = getMatchedPattern(normalizedCommand);
  if (matchedPattern !== null) {
    return err(
      SystemToolExecutionError.permissionDenied("Command is blocked by security policy", {
        command,
        matchedPattern,
        reason: "banned_command",
      }),
    );
  }

  return ok(undefined);
}

export function isBannedCommand(command: string): boolean {
  return getMatchedPattern(command.trim()) !== null;
}

function getMatchedPattern(command: string): string | null {
  const lowerCommand = command.toLowerCase();

  for (const pattern of BANNED_COMMANDS) {
    if (pattern === "su") {
      if (lowerCommand === "su" || lowerCommand.startsWith("su ") || lowerCommand.endsWith("/su")) {
        return pattern;
      }
      continue;
    }

    if (lowerCommand.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }

  return null;
}
