import { describe, expect, it } from "bun:test";

import { createHarnessEventBus, ToolPipeline } from "../../src/harness";
import type { AfterToolHook, BeforeToolHook, ToolPipelineResult } from "../../src/harness";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-regression",
  userId: "user-regression",
  workspaceId: "ws-regression",
};

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

function createToolCall(id: string, name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id, name, arguments: args };
}

describe("ToolPipeline regression: error propagation", () => {
  it("propagates tool execution errors as error status results", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.fail", () => {
        throw new Error("Simulated tool failure");
      }),
    );

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const result = await pipeline.execute(
      createToolCall("call-err", "tool.fail"),
      toolContext,
    );

    expect(result.status).toBe("error");
    expect(result.output).toBe("Simulated tool failure");
    expect(result.metadata.callId).toBe("call-err");
    expect(result.metadata.name).toBe("tool.fail");
    expect(result.metadata.truncated).toBe(false);
  });

  it("returns error result for unregistered tool names", async () => {
    const registry = new ToolRegistry();
    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const result = await pipeline.execute(
      createToolCall("call-missing", "nonexistent.tool"),
      toolContext,
    );

    expect(result.status).toBe("error");
    expect(typeof result.output).toBe("string");
    expect(result.metadata.callId).toBe("call-missing");
  });

  it("returns error result with fallback message for non-Error thrown values", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.throw-string", () => {
        throw "raw string error";
      }),
    );

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const result = await pipeline.execute(
      createToolCall("call-str", "tool.throw-string"),
      toolContext,
    );

    expect(result.status).toBe("error");
    expect(typeof result.output).toBe("string");
  });

  it("returns error result with ToolResult.error field", async () => {
    const registry = new ToolRegistry();
    const tool: Tool = {
      definition: {
        name: "tool.with-error",
        description: "Returns error in result",
        parameters: { type: "object", properties: {} },
      },
      async execute(): Promise<ToolResult> {
        return {
          callId: "call-with-err",
          name: "tool.with-error",
          result: null,
          error: "Explicit error from tool",
        };
      },
    };
    registry.register(tool);

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const result = await pipeline.execute(
      createToolCall("call-with-err", "tool.with-error"),
      toolContext,
    );

    expect(result.status).toBe("error");
    expect(result.output).toBe("Explicit error from tool");
  });
});

describe("ToolPipeline regression: hook chaining", () => {
  it("runs multiple before hooks in registration order", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.ok", () => "done"));

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const order: string[] = [];
    pipeline.beforeEach(() => { order.push("before-1"); });
    pipeline.beforeEach(() => { order.push("before-2"); });
    pipeline.beforeEach(() => { order.push("before-3"); });

    await pipeline.execute(createToolCall("call-hooks", "tool.ok"), toolContext);

    expect(order).toEqual(["before-1", "before-2", "before-3"]);
  });

  it("runs multiple after hooks in registration order", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.ok", () => "done"));

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const order: string[] = [];
    pipeline.afterEach(() => { order.push("after-1"); });
    pipeline.afterEach(() => { order.push("after-2"); });
    pipeline.afterEach(() => { order.push("after-3"); });

    await pipeline.execute(createToolCall("call-hooks", "tool.ok"), toolContext);

    expect(order).toEqual(["after-1", "after-2", "after-3"]);
  });

  it("isolates after-hook failures so subsequent hooks still run", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.ok", () => "done"));

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const order: string[] = [];
    pipeline.afterEach(() => { order.push("after-1"); throw new Error("hook-1 fail"); });
    pipeline.afterEach(() => { order.push("after-2"); });

    const result = await pipeline.execute(createToolCall("call-iso", "tool.ok"), toolContext);

    expect(result.status).toBe("success");
    expect(order).toEqual(["after-1", "after-2"]);
  });

  it("still runs after hooks when tool execution fails", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.fail", () => {
        throw new Error("boom");
      }),
    );

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const afterResults: ToolPipelineResult[] = [];
    pipeline.afterEach((result) => { afterResults.push(result); });

    const result = await pipeline.execute(createToolCall("call-fail", "tool.fail"), toolContext);

    expect(result.status).toBe("error");
    expect(afterResults).toHaveLength(1);
    expect(afterResults[0]?.status).toBe("error");
  });

  it("passes correct toolCall and context to hooks", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.ok", () => "done"));

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    let capturedToolCall: ToolCall | undefined;
    let capturedContext: ToolContext | undefined;
    pipeline.beforeEach((tc, ctx) => {
      capturedToolCall = tc;
      capturedContext = ctx;
    });

    const tc = createToolCall("call-ctx", "tool.ok", { value: "test" });
    await pipeline.execute(tc, toolContext);

    expect(capturedToolCall?.id).toBe("call-ctx");
    expect(capturedToolCall?.name).toBe("tool.ok");
    expect(capturedContext?.conversationId).toBe("conv-regression");
  });
});

describe("ToolPipeline regression: parallel batch edge cases", () => {
  it("handles empty batch gracefully", async () => {
    const registry = new ToolRegistry();
    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const results = await pipeline.executeBatch([], toolContext);

    expect(results).toHaveLength(0);
  });

  it("handles single-item batch", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.single", () => "one"));

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const results = await pipeline.executeBatch(
      [createToolCall("call-single", "tool.single")],
      toolContext,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("success");
  });

  it("returns error results for failing items in a batch without affecting others", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.ok", () => "success"));
    registry.register(
      createMockTool("tool.fail", () => {
        throw new Error("batch item failure");
      }),
    );

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const results = await pipeline.executeBatch(
      [
        createToolCall("call-ok-1", "tool.ok"),
        createToolCall("call-fail", "tool.fail"),
        createToolCall("call-ok-2", "tool.ok"),
      ],
      toolContext,
    );

    expect(results).toHaveLength(3);
    expect(results[0]?.status).toBe("success");
    expect(results[1]?.status).toBe("error");
    expect(results[2]?.status).toBe("success");
  });

  it("preserves input order for batch results even with varying execution times", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return "slow";
      }),
    );
    registry.register(createMockTool("tool.fast", () => "fast"));

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const results = await pipeline.executeBatch(
      [
        createToolCall("call-slow", "tool.slow"),
        createToolCall("call-fast", "tool.fast"),
      ],
      toolContext,
    );

    expect(results[0]?.metadata.callId).toBe("call-slow");
    expect(results[1]?.metadata.callId).toBe("call-fast");
  });

  it("executeMany runs calls in parallel and preserves call ids", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return "slow";
      }),
    );
    registry.register(
      createMockTool("tool.fast", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return "fast";
      }),
    );

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const startedAt = Date.now();
    const results = await pipeline.executeMany(
      [
        createToolCall("call-slow", "tool.slow"),
        createToolCall("call-fast", "tool.fast"),
      ],
      toolContext,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(results).toHaveLength(2);
    expect(results[0]?.metadata.callId).toBe("call-slow");
    expect(results[1]?.metadata.callId).toBe("call-fast");
    expect(results[0]?.output).toBe("slow");
    expect(results[1]?.output).toBe("fast");
    expect(elapsedMs).toBeLessThan(100);
  });

  it("executeMany returns normalized errors without blocking successful calls", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.ok", () => "ok"));
    registry.register(
      createMockTool("tool.fail", () => {
        throw new Error("failure in tool");
      }),
    );

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const results = await pipeline.executeMany(
      [
        createToolCall("ok", "tool.ok"),
        createToolCall("bad", "tool.fail"),
      ],
      toolContext,
    );

    expect(results[0]?.status).toBe("success");
    expect(results[0]?.metadata.callId).toBe("ok");
    expect(results[1]?.status).toBe("error");
    expect(results[1]?.metadata.callId).toBe("bad");
    expect(results[1]?.output).toBe("failure in tool");
  });
});

describe("ToolPipeline regression: abort signal", () => {
  it("returns error when abort signal is already aborted before execution", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.ok", () => "done"));

    const controller = new AbortController();
    controller.abort("pre-aborted");

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
      signal: controller.signal,
    });

    const result = await pipeline.execute(
      createToolCall("call-abort", "tool.ok"),
      toolContext,
    );

    expect(result.status).toBe("error");
    expect(result.output).toBe("Tool execution aborted");
  });
});

describe("ToolPipeline regression: truncation edge cases", () => {
  it("truncates JSON-serialized object output when it exceeds max length", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.big-obj", () => ({
        data: "x".repeat(500),
      })),
    );

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
      maxOutputLength: 50,
    });

    const result = await pipeline.execute(
      createToolCall("call-big", "tool.big-obj"),
      toolContext,
    );

    expect(result.status).toBe("truncated");
    expect(result.metadata.truncated).toBe(true);
    expect(typeof result.output).toBe("string");
    expect((result.output as string).endsWith("...(truncated)")).toBe(true);
  });

  it("does not truncate output when maxOutputLength is 0 (disabled)", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.big", () => "x".repeat(1000)));

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
      maxOutputLength: 0,
    });

    const result = await pipeline.execute(
      createToolCall("call-no-trunc", "tool.big"),
      toolContext,
    );

    expect(result.status).toBe("success");
    expect(result.metadata.truncated).toBe(false);
  });

  it("handles null and undefined output without truncation errors", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.null", () => null));

    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
    });

    const result = await pipeline.execute(
      createToolCall("call-null", "tool.null"),
      toolContext,
    );

    expect(result.status).toBe("success");
    expect(result.metadata.truncated).toBe(false);
  });
});

describe("ToolPipeline regression: event bus integration", () => {
  it("emits tool_call_start and tool_call_end events for each execution", async () => {
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.ok", () => "done"));

    const eventBus = createHarnessEventBus();
    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
      eventBus,
    });

    const startEvents: string[] = [];
    const endEvents: string[] = [];
    eventBus.on("tool_call_start", (e) => { startEvents.push(e.payload.toolCall.id); });
    eventBus.on("tool_call_end", (e) => { endEvents.push(e.payload.result.callId); });

    await pipeline.execute(createToolCall("call-evt", "tool.ok"), toolContext);

    expect(startEvents).toEqual(["call-evt"]);
    expect(endEvents).toEqual(["call-evt"]);
  });

  it("emits tool_call_end with error status when tool fails", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.fail", () => {
        throw new Error("fail");
      }),
    );

    const eventBus = createHarnessEventBus();
    const pipeline = new ToolPipeline({
      executor: new ToolExecutor(registry),
      eventBus,
    });

    const endPayloads: Array<{ error?: string }> = [];
    eventBus.on("tool_call_end", (e) => {
      endPayloads.push({ error: e.payload.result.error });
    });

    await pipeline.execute(createToolCall("call-fail-evt", "tool.fail"), toolContext);

    expect(endPayloads).toHaveLength(1);
    expect(endPayloads[0]?.error).toBeDefined();
  });
});
