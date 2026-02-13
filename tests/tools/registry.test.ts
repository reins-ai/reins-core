import { describe, expect, it } from "bun:test";

import { ToolError } from "../../src/errors";
import {
  getBuiltinSystemToolDefinitions,
  getBuiltinToolDefinitions,
  ToolRegistry,
} from "../../src/tools";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../../src/types";

const testContext: ToolContext = {
  conversationId: "conv-1",
  userId: "user-1",
  workspaceId: "ws-1",
};

function createMockTool(
  name: string,
  handler: (args: Record<string, unknown>) => unknown,
): Tool {
  return {
    definition: {
      name,
      description: `Mock tool: ${name}`,
      parameters: {
        type: "object",
        properties: {
          value: {
            type: "string",
            description: "Example argument",
          },
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      return {
        callId: "tool-call",
        name,
        result: handler(args),
      };
    },
  };
}

function createMockToolWithDefinition(
  definition: ToolDefinition,
  handler: (args: Record<string, unknown>) => unknown = () => ({ ok: true }),
): Tool {
  return {
    definition,
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      return {
        callId: "tool-call",
        name: definition.name,
        result: handler(args),
      };
    },
  };
}

const systemToolNames = ["bash", "read", "write", "edit", "glob", "grep", "ls"];

describe("ToolRegistry", () => {
  it("registers and gets tools by name", () => {
    const registry = new ToolRegistry();
    const tool = createMockTool("notes.create", () => ({ created: true }));

    registry.register(tool);

    expect(registry.get("notes.create")).toBe(tool);
    expect(registry.has("notes.create")).toBe(true);
  });

  it("throws on duplicate registration", () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("calendar.create", () => ({ ok: true })));

    expect(() => registry.register(createMockTool("calendar.create", () => ({ ok: true })))).toThrow(
      ToolError,
    );
  });

  it("registers a system tool definition", () => {
    const registry = new ToolRegistry();
    const builtinDefinitions = getBuiltinToolDefinitions();
    const bashDefinition = builtinDefinitions.find((definition) => definition.name === "bash");

    expect(bashDefinition).toBeDefined();

    registry.register(createMockToolWithDefinition(bashDefinition!));

    expect(registry.has("bash")).toBe(true);
  });

  it("retrieves a system tool by name", () => {
    const registry = new ToolRegistry();
    const builtinDefinitions = getBuiltinToolDefinitions();
    const readDefinition = builtinDefinitions.find((definition) => definition.name === "read");

    expect(readDefinition).toBeDefined();

    registry.register(createMockToolWithDefinition(readDefinition!));

    expect(registry.get("read")?.definition.name).toBe("read");
  });

  it("lists all tools including system tools", () => {
    const registry = new ToolRegistry();
    const builtinDefinitions = getBuiltinToolDefinitions();

    for (const name of systemToolNames) {
      const definition = builtinDefinitions.find((toolDefinition) => toolDefinition.name === name);
      expect(definition).toBeDefined();
      registry.register(createMockToolWithDefinition(definition!));
    }

    expect(registry.list().map((tool) => tool.definition.name)).toEqual(systemToolNames);
  });

  it("prevents duplicate system tool registration by name", () => {
    const registry = new ToolRegistry();
    const builtinDefinitions = getBuiltinToolDefinitions();
    const grepDefinition = builtinDefinitions.find((definition) => definition.name === "grep");

    expect(grepDefinition).toBeDefined();

    registry.register(createMockToolWithDefinition(grepDefinition!));

    expect(() => registry.register(createMockToolWithDefinition(grepDefinition!))).toThrow(ToolError);
  });

  it("validates system tool definition structure", () => {
    const systemDefinitions = getBuiltinSystemToolDefinitions();

    expect(systemDefinitions).toHaveLength(systemToolNames.length);

    for (const definition of systemDefinitions) {
      expect(systemToolNames).toContain(definition.name);
      expect(definition.description.length).toBeGreaterThan(0);
      expect(definition.input_schema.type).toBe("object");
      expect(Object.keys(definition.input_schema.properties).length).toBeGreaterThan(0);
    }
  });

  it("includes all builtin system tools in provider definitions", () => {
    const definitions = getBuiltinToolDefinitions();

    for (const name of systemToolNames) {
      const definition = definitions.find((toolDefinition) => toolDefinition.name === name);
      expect(definition).toBeDefined();
      expect(definition?.parameters.type).toBe("object");
      expect(Object.keys(definition?.parameters.properties ?? {}).length).toBeGreaterThan(0);
    }
  });

  it("returns tools and definitions in registration order", () => {
    const registry = new ToolRegistry();
    const first = createMockTool("calendar.list", () => ({ events: [] }));
    const second = createMockTool("reminders.list", () => ({ reminders: [] }));

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toEqual([first, second]);
    expect(registry.getDefinitions()).toEqual([first.definition, second.definition]);
  });

  it("getOrThrow returns tool when present", () => {
    const registry = new ToolRegistry();
    const tool = createMockTool("notes.search", () => ({ hits: [] }));
    registry.register(tool);

    expect(registry.getOrThrow("notes.search")).toBe(tool);
  });

  it("getOrThrow throws when tool is missing", () => {
    const registry = new ToolRegistry();

    expect(() => registry.getOrThrow("plugins.run")).toThrow(ToolError);
  });

  it("removes tools and reports whether they existed", () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("temp.tool", () => ({ temp: true })));

    expect(registry.remove("temp.tool")).toBe(true);
    expect(registry.remove("temp.tool")).toBe(false);
    expect(registry.has("temp.tool")).toBe(false);
  });

  it("clears all tools", async () => {
    const registry = new ToolRegistry();
    const first = createMockTool("calendar.create", () => ({ id: "1" }));
    const second = createMockTool("reminders.create", () => ({ id: "2" }));

    registry.register(first);
    registry.register(second);

    registry.clear();

    expect(registry.list()).toHaveLength(0);
    expect(registry.has("calendar.create")).toBe(false);
    expect(registry.has("reminders.create")).toBe(false);

    const executeCheck = await first.execute({ value: "x" }, testContext);
    expect(executeCheck.result).toEqual({ id: "1" });
  });
});
