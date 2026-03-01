import { ChannelCommandRegistry } from "../registry";
import type { CommandContext, CommandHandler, CommandResult } from "../types";

/**
 * Creates a `/help` command handler bound to the given registry.
 *
 * The returned handler dynamically lists all registered commands with their
 * descriptions and aliases by reading from the registry at invocation time.
 */
export function createHelpHandler(
  registry: ChannelCommandRegistry,
): CommandHandler {
  return async (
    _context: CommandContext,
    _args: string[],
  ): Promise<CommandResult> => {
    const commands = registry.list();

    if (commands.length === 0) {
      return {
        kind: "text",
        text: "No commands registered.",
        success: true,
      };
    }

    const lines = commands.map((cmd) => {
      const aliasText =
        cmd.aliases && cmd.aliases.length > 0
          ? ` (aliases: ${cmd.aliases.map((a) => `/${a}`).join(", ")})`
          : "";
      return `/${cmd.name}${aliasText} — ${cmd.description}`;
    });

    return {
      kind: "text",
      text: `**Available Commands**\n\n${lines.join("\n")}`,
      success: true,
    };
  };
}
