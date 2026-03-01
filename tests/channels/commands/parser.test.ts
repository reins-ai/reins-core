import { describe, expect, it } from "bun:test";
import { parseCommand } from "../../../src/channels/commands/parser";
import type { CommandLookup } from "../../../src/channels/commands/parser";

function makeLookup(names: string[]): CommandLookup {
  const set = new Set(names);
  return { has: (name: string) => set.has(name) };
}

describe("parseCommand", () => {
  describe("non-command input", () => {
    it("returns null for text without leading slash", () => {
      const lookup = makeLookup(["help"]);
      expect(parseCommand("hello world", lookup)).toBeNull();
    });

    it("returns null for empty string", () => {
      const lookup = makeLookup(["help"]);
      expect(parseCommand("", lookup)).toBeNull();
    });

    it("returns null for whitespace-only string", () => {
      const lookup = makeLookup(["help"]);
      expect(parseCommand("   ", lookup)).toBeNull();
    });
  });

  describe("empty command name", () => {
    it("returns null when command is / alone", () => {
      const lookup = makeLookup(["help"]);
      expect(parseCommand("/", lookup)).toBeNull();
    });

    it("returns null when command is /@something (empty name before @)", () => {
      const lookup = makeLookup(["help"]);
      expect(parseCommand("/@MyBot", lookup)).toBeNull();
    });
  });

  describe("unregistered commands", () => {
    it("returns null when command is not registered", () => {
      const lookup = makeLookup(["help"]);
      expect(parseCommand("/unknown", lookup)).toBeNull();
    });

    it("returns null when registry is empty", () => {
      const lookup = makeLookup([]);
      expect(parseCommand("/help", lookup)).toBeNull();
    });
  });

  describe("successful parsing", () => {
    it("returns ParsedCommand for a registered command with no args", () => {
      const lookup = makeLookup(["help"]);
      const result = parseCommand("/help", lookup);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("help");
      expect(result!.args).toEqual([]);
    });

    it("returns ParsedCommand with correct args", () => {
      const lookup = makeLookup(["model"]);
      const result = parseCommand("/model gpt-4 fast", lookup);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("model");
      expect(result!.args).toEqual(["gpt-4", "fast"]);
    });

    it("returns raw text as-is in the result", () => {
      const raw = "  /help arg1  ";
      const lookup = makeLookup(["help"]);
      const result = parseCommand(raw, lookup);
      expect(result).not.toBeNull();
      expect(result!.raw).toBe(raw);
    });
  });

  describe("Telegram @botname suffix", () => {
    it("strips @botname suffix and matches registered command", () => {
      const lookup = makeLookup(["help"]);
      const result = parseCommand("/help@MyBot", lookup);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("help");
    });

    it("strips @botname suffix and preserves args", () => {
      const lookup = makeLookup(["model"]);
      const result = parseCommand("/model@ReinsBot gpt-4", lookup);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("model");
      expect(result!.args).toEqual(["gpt-4"]);
    });
  });

  describe("case insensitivity", () => {
    it("lowercases command name to match registered command", () => {
      const lookup = makeLookup(["help"]);
      const result = parseCommand("/Help", lookup);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("help");
    });

    it("lowercases command name with @botname suffix", () => {
      const lookup = makeLookup(["status"]);
      const result = parseCommand("/STATUS@Bot", lookup);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("status");
    });
  });

  describe("whitespace handling", () => {
    it("trims leading whitespace from input", () => {
      const lookup = makeLookup(["help"]);
      const result = parseCommand("   /help", lookup);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("help");
    });

    it("trims trailing whitespace from input", () => {
      const lookup = makeLookup(["help"]);
      const result = parseCommand("/help   ", lookup);
      expect(result).not.toBeNull();
      expect(result!.name).toBe("help");
      expect(result!.args).toEqual([]);
    });

    it("collapses multiple spaces between args", () => {
      const lookup = makeLookup(["model"]);
      const result = parseCommand("/model   gpt-4   fast", lookup);
      expect(result).not.toBeNull();
      expect(result!.args).toEqual(["gpt-4", "fast"]);
    });
  });
});
