import { describe, expect, it } from "bun:test";
import { ChannelCommandRegistry } from "../../../src/channels/commands/registry";
import { ChannelError } from "../../../src/channels/errors";
import type { CommandDefinition } from "../../../src/channels/commands/types";
import type { CommandResult } from "../../../src/channels/commands/types";

function makeCommand(
  name: string,
  aliases?: string[],
): CommandDefinition {
  return {
    name,
    description: `${name} command`,
    handler: async (): Promise<CommandResult> => ({
      kind: "text",
      text: "ok",
      success: true,
    }),
    aliases,
  };
}

describe("ChannelCommandRegistry", () => {
  describe("register and get", () => {
    it("stores a command and retrieves it by name", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help"));
      const cmd = registry.get("help");
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe("help");
    });

    it("normalizes name to lowercase on register and get", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("Help"));
      const cmd = registry.get("help");
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe("help");
    });

    it("retrieves command with uppercase lookup", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("status"));
      const cmd = registry.get("STATUS");
      expect(cmd).toBeDefined();
      expect(cmd!.name).toBe("status");
    });

    it("returns undefined for unregistered command", () => {
      const registry = new ChannelCommandRegistry();
      expect(registry.get("unknown")).toBeUndefined();
    });
  });

  describe("register — error cases", () => {
    it("throws ChannelError on empty command name", () => {
      const registry = new ChannelCommandRegistry();
      expect(() => registry.register(makeCommand(""))).toThrow(ChannelError);
    });

    it("throws ChannelError on whitespace-only command name", () => {
      const registry = new ChannelCommandRegistry();
      expect(() => registry.register(makeCommand("   "))).toThrow(ChannelError);
    });

    it("throws ChannelError on duplicate command name", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help"));
      expect(() => registry.register(makeCommand("help"))).toThrow(ChannelError);
    });

    it("throws ChannelError on duplicate command name with different casing", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help"));
      expect(() => registry.register(makeCommand("HELP"))).toThrow(ChannelError);
    });
  });

  describe("register — aliases", () => {
    it("stores aliases and resolves alias to canonical command via get", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help", ["h", "?"]));
      const byAlias = registry.get("h");
      expect(byAlias).toBeDefined();
      expect(byAlias!.name).toBe("help");
      const byAlias2 = registry.get("?");
      expect(byAlias2).toBeDefined();
      expect(byAlias2!.name).toBe("help");
    });

    it("throws ChannelError when alias equals command name", () => {
      const registry = new ChannelCommandRegistry();
      expect(() =>
        registry.register(makeCommand("help", ["help"])),
      ).toThrow(ChannelError);
    });

    it("throws ChannelError when alias equals command name with different casing", () => {
      const registry = new ChannelCommandRegistry();
      expect(() =>
        registry.register(makeCommand("help", ["HELP"])),
      ).toThrow(ChannelError);
    });

    it("throws ChannelError on empty alias", () => {
      const registry = new ChannelCommandRegistry();
      expect(() =>
        registry.register(makeCommand("help", [""])),
      ).toThrow(ChannelError);
    });

    it("throws ChannelError on whitespace-only alias", () => {
      const registry = new ChannelCommandRegistry();
      expect(() =>
        registry.register(makeCommand("help", ["   "])),
      ).toThrow(ChannelError);
    });

    it("throws ChannelError on duplicate alias within same registration", () => {
      const registry = new ChannelCommandRegistry();
      expect(() =>
        registry.register(makeCommand("help", ["h", "h"])),
      ).toThrow(ChannelError);
    });

    it("throws ChannelError when alias conflicts with existing command name", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("status"));
      expect(() =>
        registry.register(makeCommand("help", ["status"])),
      ).toThrow(ChannelError);
    });

    it("throws ChannelError when alias conflicts with existing alias", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help", ["h"]));
      expect(() =>
        registry.register(makeCommand("status", ["h"])),
      ).toThrow(ChannelError);
    });
  });

  describe("has", () => {
    it("returns true for registered command name", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help"));
      expect(registry.has("help")).toBe(true);
    });

    it("returns true for registered alias", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help", ["h"]));
      expect(registry.has("h")).toBe(true);
    });

    it("returns true with case-insensitive lookup", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help"));
      expect(registry.has("HELP")).toBe(true);
    });

    it("returns false for unknown name", () => {
      const registry = new ChannelCommandRegistry();
      expect(registry.has("unknown")).toBe(false);
    });

    it("returns false for empty string", () => {
      const registry = new ChannelCommandRegistry();
      expect(registry.has("")).toBe(false);
    });
  });

  describe("list", () => {
    it("returns all registered commands", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help"));
      registry.register(makeCommand("status"));
      const commands = registry.list();
      expect(commands).toHaveLength(2);
      const names = commands.map((c) => c.name).sort();
      expect(names).toEqual(["help", "status"]);
    });

    it("does not include aliases as separate entries", () => {
      const registry = new ChannelCommandRegistry();
      registry.register(makeCommand("help", ["h", "?"]));
      const commands = registry.list();
      expect(commands).toHaveLength(1);
      expect(commands[0].name).toBe("help");
    });

    it("returns empty array when no commands registered", () => {
      const registry = new ChannelCommandRegistry();
      expect(registry.list()).toEqual([]);
    });
  });
});
