import { ChannelError } from "../errors";
import type { CommandDefinition } from "./types";

function normalizeCommandName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Registry for channel slash commands.
 *
 * Commands are indexed by their canonical name, and aliases are mapped back to
 * that canonical name for lookup.
 */
export class ChannelCommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly aliases = new Map<string, string>();

  /**
   * Registers a command definition.
   *
   * Throws `ChannelError` when the normalized command name, any normalized
   * alias, or duplicate aliases conflict with already-registered commands.
   */
  register(command: CommandDefinition): void {
    const name = normalizeCommandName(command.name);
    if (!name) {
      throw new ChannelError("Command name cannot be empty");
    }

    if (this.commands.has(name) || this.aliases.has(name)) {
      throw new ChannelError(`Command already registered: "${name}"`);
    }

    const normalizedAliases: string[] = [];
    const seenAliases = new Set<string>();

    for (const alias of command.aliases ?? []) {
      const normalizedAlias = normalizeCommandName(alias);
      if (!normalizedAlias) {
        throw new ChannelError("Command alias cannot be empty");
      }

      if (normalizedAlias === name) {
        throw new ChannelError(
          `Command alias duplicates command name: "${normalizedAlias}"`,
        );
      }

      if (seenAliases.has(normalizedAlias)) {
        throw new ChannelError(`Duplicate command alias: "${normalizedAlias}"`);
      }

      if (
        this.commands.has(normalizedAlias) ||
        this.aliases.has(normalizedAlias)
      ) {
        throw new ChannelError(
          `Command alias already registered: "${normalizedAlias}"`,
        );
      }

      seenAliases.add(normalizedAlias);
      normalizedAliases.push(normalizedAlias);
    }

    const normalizedCommand: CommandDefinition = {
      ...command,
      name,
      aliases: normalizedAliases.length > 0 ? normalizedAliases : undefined,
    };

    this.commands.set(name, normalizedCommand);
    for (const alias of normalizedAliases) {
      this.aliases.set(alias, name);
    }
  }

  /**
   * Gets a command by name or alias.
   *
   * Returns `undefined` when no command matches the provided value.
   */
  get(name: string): CommandDefinition | undefined {
    const normalizedName = normalizeCommandName(name);
    const canonicalName = this.aliases.get(normalizedName) ?? normalizedName;
    return this.commands.get(canonicalName);
  }

  /**
   * Checks whether a command name or alias is registered.
   */
  has(name: string): boolean {
    const normalizedName = normalizeCommandName(name);
    return this.commands.has(normalizedName) || this.aliases.has(normalizedName);
  }

  /**
   * Lists all registered commands by primary name.
   *
   * Aliases are not returned as separate entries.
   */
  list(): CommandDefinition[] {
    return Array.from(this.commands.values());
  }
}
