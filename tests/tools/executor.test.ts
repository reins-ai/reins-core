import { describe, expect, it } from "bun:test";

import { ToolError } from "../../src/errors";
import {
  ToolExecutor,
  ToolRegistry,
  deserializeToolCall,
  deserializeToolResult,
  serializeToolCall,
  serializeToolResult,
} from "../../src/tools";
import type { Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-123",
  userId: "user-123",
  workspaceId: "ws-123",
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function createMockTool(
  name: string,
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>,
): Tool {
  return {
    definition: {
      name,
      description: `Mock tool: ${name}`,
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" },
        },
      },
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      return {
        callId: "ignored-by-executor",
        name: `${name}.internal`,
        result: await handler(args),
      };
    },
  };
}

describe("ToolExecutor", () => {
  it("executes a single tool call successfully", async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    registry.register(createMockTool("notes.create", (args) => ({ saved: args.value })));

    const result = await executor.execute(
      {
        id: "call-1",
        name: "notes.create",
        arguments: { value: "Buy milk" },
      },
      toolContext,
    );

    expect(result).toEqual({
      callId: "call-1",
      name: "notes.create",
      result: { saved: "Buy milk" },
    });
  });

  it("returns an error result when tool is not found", async () => {
    const executor = new ToolExecutor(new ToolRegistry());

    const result = await executor.execute(
      {
        id: "call-missing",
        name: "calendar.create",
        arguments: { title: "Standup" },
      },
      toolContext,
    );

    expect(result.callId).toBe("call-missing");
    expect(result.name).toBe("calendar.create");
    expect(result.result).toBeNull();
    expect(result.error).toBe("Tool not found: calendar.create");
  });

  it("catches execution errors and returns an error result", async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);
    registry.register(
      createMockTool("reminders.create", () => {
        throw new Error("Failed to create reminder");
      }),
    );

    const result = await executor.execute(
      {
        id: "call-error",
        name: "reminders.create",
        arguments: { title: "Pay rent" },
      },
      toolContext,
    );

    expect(result.callId).toBe("call-error");
    expect(result.name).toBe("reminders.create");
    expect(result.result).toBeNull();
    expect(result.error).toBe("Failed to create reminder");
  });

  it("executes many tool calls in parallel and keeps input order", async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    registry.register(
      createMockTool("tool.a", async (args) => {
        await sleep(80);
        return { tool: "a", value: args.value };
      }),
    );
    registry.register(
      createMockTool("tool.b", async (args) => {
        await sleep(80);
        return { tool: "b", value: args.value };
      }),
    );

    const calls: ToolCall[] = [
      { id: "call-a", name: "tool.a", arguments: { value: "x" } },
      { id: "call-b", name: "tool.b", arguments: { value: "y" } },
    ];

    const startedAt = Date.now();
    const results = await executor.executeMany(calls, toolContext);
    const elapsedMs = Date.now() - startedAt;

    expect(results).toHaveLength(2);
    expect(results[0]?.callId).toBe("call-a");
    expect(results[1]?.callId).toBe("call-b");
    expect(results[0]?.result).toEqual({ tool: "a", value: "x" });
    expect(results[1]?.result).toEqual({ tool: "b", value: "y" });
    expect(elapsedMs).toBeLessThan(150);
  });

  it("executeMany returns both successes and failures", async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    registry.register(createMockTool("tool.success", () => ({ ok: true })));
    registry.register(
      createMockTool("tool.fail", () => {
        throw new Error("Boom");
      }),
    );

    const results = await executor.executeMany(
      [
        { id: "ok", name: "tool.success", arguments: {} },
        { id: "bad", name: "tool.fail", arguments: {} },
      ],
      toolContext,
    );

    expect(results[0]).toEqual({
      callId: "ok",
      name: "tool.success",
      result: { ok: true },
    });
    expect(results[1]).toEqual({
      callId: "bad",
      name: "tool.fail",
      result: null,
      error: "Boom",
    });
  });

  it("executeWithTimeout resolves when execution completes in time", async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    registry.register(
      createMockTool("notes.search", async () => {
        await sleep(20);
        return { hits: ["match"] };
      }),
    );

    const result = await executor.executeWithTimeout(
      {
        id: "timeout-ok",
        name: "notes.search",
        arguments: { value: "meeting" },
      },
      toolContext,
      100,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toEqual({ hits: ["match"] });
  });

  it("executeWithTimeout returns timeout error when execution exceeds limit", async () => {
    const registry = new ToolRegistry();
    const executor = new ToolExecutor(registry);

    registry.register(
      createMockTool("calendar.list", async () => {
        await sleep(80);
        return { events: [] };
      }),
    );

    const result = await executor.executeWithTimeout(
      {
        id: "timeout-fail",
        name: "calendar.list",
        arguments: {},
      },
      toolContext,
      10,
    );

    expect(result.callId).toBe("timeout-fail");
    expect(result.name).toBe("calendar.list");
    expect(result.result).toBeNull();
    expect(result.error).toBe("Tool execution timed out after 10ms");
  });
});

describe("tool serialization", () => {
  it("serializes and deserializes tool calls and results", () => {
    const toolCall: ToolCall = {
      id: "call-serialize",
      name: "notes.create",
      arguments: { title: "Ideas", tags: ["work"] },
    };

    const toolResult: ToolResult = {
      callId: "call-serialize",
      name: "notes.create",
      result: { id: "n1", created: true },
    };

    const serializedCall = serializeToolCall(toolCall);
    const serializedResult = serializeToolResult(toolResult);

    expect(deserializeToolCall(serializedCall)).toEqual(toolCall);
    expect(deserializeToolResult(serializedResult)).toEqual(toolResult);
  });

  it("throws ToolError for invalid serialized tool call payload", () => {
    expect(() =>
      deserializeToolCall({
        id: "invalid",
        name: "notes.create",
        argumentsJson: "[]",
      }),
    ).toThrow(ToolError);
  });
});
