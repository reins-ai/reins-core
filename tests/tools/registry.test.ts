import { describe, expect, it } from "bun:test";

import { ToolError } from "../../src/errors";
import { ToolRegistry } from "../../src/tools";
import type { Tool, ToolContext, ToolResult } from "../../src/types";

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
