import { describe, expect, it } from "bun:test";

import { createHarnessEventBus, ToolPipeline } from "../../src/harness";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-pipeline",
  userId: "user-pipeline",
  workspaceId: "ws-pipeline",
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
        callId: "ignored",
        name: `${name}.internal`,
        result: await handler(args),
      };
    },
  };
}

describe("ToolPipeline", () => {
  it("runs hooks and emits start/end events", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("notes.create", (args) => ({ saved: args.value })));

    const executor = new ToolExecutor(registry);
    const eventBus = createHarnessEventBus();
    const pipeline = new ToolPipeline({ executor, eventBus });

    const audit: string[] = [];
    eventBus.on("tool_call_start", (event) => {
      audit.push(`event:start:${event.payload.toolCall.id}`);
    });
    eventBus.on("tool_call_end", (event) => {
      audit.push(`event:end:${event.payload.result.callId}`);
    });

    pipeline.beforeEach((toolCall) => {
      audit.push(`hook:before:${toolCall.id}`);
    });
    pipeline.afterEach((result) => {
      audit.push(`hook:after:${result.metadata.callId}`);
    });

    const result = await pipeline.execute(
      {
        id: "call-1",
        name: "notes.create",
        arguments: { value: "Buy milk" },
      },
      toolContext,
    );

    expect(result.status).toBe("success");
    expect(result.output).toEqual({ saved: "Buy milk" });
    expect(result.metadata.callId).toBe("call-1");
    expect(result.metadata.name).toBe("notes.create");
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.truncated).toBe(false);
    expect(audit).toEqual([
      "event:start:call-1",
      "hook:before:call-1",
      "hook:after:call-1",
      "event:end:call-1",
    ]);
  });

  it("truncates oversized string output with configured max length", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("notes.dump", () => "abcdefghijklmnopqrstuvwxyz"));

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
      maxOutputLength: 18,
    });

    const result = await pipeline.execute(
      {
        id: "call-truncate",
        name: "notes.dump",
        arguments: {},
      },
      toolContext,
    );

    expect(result.status).toBe("truncated");
    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.originalLength).toBe(26);
    expect(result.output).toBe("abcd...(truncated)");
  });

  it("executes batch calls in parallel while preserving input order", async () => {
    const registry = new ToolRegistry();
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

    const pipeline = new ToolPipeline({ executor: new ToolExecutor(registry) });
    const calls: ToolCall[] = [
      { id: "call-a", name: "tool.a", arguments: { value: "x" } },
      { id: "call-b", name: "tool.b", arguments: { value: "y" } },
    ];

    const startedAt = Date.now();
    const results = await pipeline.executeBatch(calls, toolContext);
    const elapsedMs = Date.now() - startedAt;

    expect(results).toHaveLength(2);
    expect(results[0]?.metadata.callId).toBe("call-a");
    expect(results[1]?.metadata.callId).toBe("call-b");
    expect(results[0]?.output).toEqual({ tool: "a", value: "x" });
    expect(results[1]?.output).toEqual({ tool: "b", value: "y" });
    expect(elapsedMs).toBeLessThan(150);
  });

  it("uses timeout defaults and returns normalized error output", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.slow", async () => {
        await sleep(50);
        return "slow";
      }),
    );

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
      defaultTimeoutMs: 10,
    });

    const result = await pipeline.execute(
      {
        id: "timeout-call",
        name: "tool.slow",
        arguments: {},
      },
      toolContext,
    );

    expect(result.status).toBe("error");
    expect(result.output).toBe("Tool execution timed out after 10ms");
    expect(result.metadata.truncated).toBe(false);
    expect(result.metadata.callId).toBe("timeout-call");
  });
});
