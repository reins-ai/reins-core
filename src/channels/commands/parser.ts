import type { ParsedCommand } from "./types";

/**
 * Minimal registry contract used by the parser to check command existence.
 * Decoupled from the full ChannelCommandRegistry to avoid circular deps
 * and allow the parser to be used before the registry class is available.
 */
export interface CommandLookup {
  has(name: string): boolean;
}

/**
 * Parse a raw message text into a structured command.
 *
 * Returns null when:
 * - text does not start with "/"
 * - text is "/" alone or "/@something" (empty command name)
 * - the command name (after stripping @botname suffix) is not registered
 *
 * Handles Telegram group format: "/command@botname arg1 arg2"
 * Case-insensitive: "/Help" matches a registered "help" command.
 *
 * @param text     Raw message text from channel.
 * @param registry Lookup to check whether a command name is registered.
 * @returns ParsedCommand if text is a registered command, null otherwise.
 */
export function parseCommand(
  text: string,
  registry: CommandLookup,
): ParsedCommand | null {
  const trimmed = text.trim();

  // Must start with /
  if (!trimmed.startsWith("/")) {
    return null;
  }

  // Split on whitespace — first token is the command, rest are args
  const tokens = trimmed.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) {
    return null;
  }

  const commandToken = tokens[0]; // e.g. "/model" or "/model@MyBot"
  const args = tokens.slice(1);

  // Strip leading slash
  const withoutSlash = commandToken.slice(1); // e.g. "model" or "model@MyBot"

  // Strip @botname suffix (Telegram group format)
  const atIndex = withoutSlash.indexOf("@");
  const commandName =
    atIndex >= 0
      ? withoutSlash.slice(0, atIndex).toLowerCase()
      : withoutSlash.toLowerCase();

  // Empty command name (just "/" or "/@something")
  if (commandName.length === 0) {
    return null;
  }

  // Only return a ParsedCommand if the name is registered
  if (!registry.has(commandName)) {
    return null;
  }

  return {
    name: commandName,
    args,
    raw: text,
  };
}
