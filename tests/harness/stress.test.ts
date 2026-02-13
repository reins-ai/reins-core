import { describe, expect, it } from "bun:test";

import {
  AgentLoop,
  DoomLoopGuard,
  ToolPipeline,
  createHarnessEventBus,
  retry,
  RetryExhaustedError,
} from "../../src/harness";
import type { AgentMessage, StepResult } from "../../src/harness";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { ChatRequest, ContentBlock, Provider, StreamEvent, Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-stress",
  userId: "user-stress",
  workspaceId: "ws-stress",
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

function createToolCall(id: string, name: string, value = ""): ToolCall {
  return { id, name, arguments: { value } };
}

async function instantSleep(_ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}

function makeHttpError(status: number): Error & { status: number } {
  const error = new Error(`HTTP ${status}`) as Error & { status: number };
  error.status = status;
  return error;
}

describe("Stress test: 15-step agent loop run", () => {
  it("completes a 15-step tool loop with message accumulation", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.action", (args) => ({
        ok: true,
        step: args.value,
      })),
    );
    const eventBus = createHarnessEventBus();
    const pipeline = new ToolPipeline({ executor: new ToolExecutor(registry), eventBus });

    const eventTypes: string[] = [];
    eventBus.on("tool_call_start", () => { eventTypes.push("start"); });
    eventBus.on("tool_call_end", () => { eventTypes.push("end"); });

    const loop = new AgentLoop({
      maxSteps: 20,
      toolPipeline: pipeline,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Execute 15 sequential tool actions" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount <= 15) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall(`call-${callCount}`, "tool.action", `step-${callCount}`)],
          };
        }
        return {
          type: "text",
          content: "All 15 steps completed successfully.",
          done: true,
        };
      },
      toolContext,
    );

    expect(result.stepsUsed).toBe(15);
    expect(result.limitReached).toBe(false);
    expect(result.aborted).toBe(false);

    // Verify message structure
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    const assistantMessages = result.messages.filter((m) => m.role === "assistant");
    expect(toolMessages).toHaveLength(15);
    expect(assistantMessages.length).toBeGreaterThanOrEqual(16); // 15 tool-call + 1 final text

    // Verify final message
    expect(result.messages[result.messages.length - 1]?.content).toBe(
      "All 15 steps completed successfully.",
    );

    // Verify events were emitted for each tool call
    expect(eventTypes.filter((t) => t === "start")).toHaveLength(15);
    expect(eventTypes.filter((t) => t === "end")).toHaveLength(15);
  });
});

describe("Stress test: agent loop with doom loop guard escalation", () => {
  it("escalates after batch failures trigger doom loop guard", async () => {
    const registry = new ToolRegistry();
    let toolCallCount = 0;
    registry.register(
      createMockTool("tool.flaky", () => {
        toolCallCount += 1;
        throw new Error(`Failure #${toolCallCount}`);
      }),
    );
    const pipeline = new ToolPipeline({ executor: new ToolExecutor(registry) });
    // The guard resets per turn, so we need enough failures in a single batch
    const guard = new DoomLoopGuard({
      maxConsecutiveFailures: 4,
      maxTotalFailures: 20,
    });

    const loop = new AgentLoop({
      maxSteps: 20,
      toolPipeline: pipeline,
      doomLoopGuard: guard,
    });

    let stepFnCalls = 0;
    const result = await loop.run(
      [{ role: "user", content: "Keep trying the flaky tool" }],
      async (_messages, options): Promise<StepResult> => {
        stepFnCalls += 1;
        if (options.toolsDisabled) {
          return {
            type: "text",
            content: "Doom loop guard triggered — stopping tool execution.",
            done: true,
          };
        }
        // Send 5 failing tool calls in one batch to exceed consecutive threshold of 4
        return {
          type: "tool_calls",
          toolCalls: [
            createToolCall(`call-${stepFnCalls}-a`, "tool.flaky"),
            createToolCall(`call-${stepFnCalls}-b`, "tool.flaky"),
            createToolCall(`call-${stepFnCalls}-c`, "tool.flaky"),
            createToolCall(`call-${stepFnCalls}-d`, "tool.flaky"),
            createToolCall(`call-${stepFnCalls}-e`, "tool.flaky"),
          ],
        };
      },
      toolContext,
    );

    // Guard should have triggered after batch failures
    expect(result.messages[result.messages.length - 1]?.content).toContain("Doom loop guard");
    expect(result.stepsUsed).toBe(1);
    expect(result.terminationReason).toBe("doom_loop_detected");
  });
});

describe("Stress test: retry chains with abort", () => {
  it("handles a long retry chain that gets aborted mid-way", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const delays: number[] = [];

    try {
      await retry(
        () => {
          attempts += 1;
          throw makeHttpError(500);
        },
        {
          maxAttempts: 20,
          baseDelayMs: 10,
          maxDelayMs: 1_000,
          jitter: false,
          signal: controller.signal,
          sleepFn: async (ms, signal) => {
            delays.push(ms);
            // Abort after 5 retry sleeps
            if (delays.length >= 5) {
              controller.abort("timeout reached");
            }
            if (signal?.aborted) {
              throw signal.reason ?? new DOMException("Aborted", "AbortError");
            }
          },
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      // Should have been aborted, not exhausted
      expect(attempts).toBeLessThanOrEqual(7);
      expect(String(error)).toContain("timeout reached");
    }

    // Verify exponential backoff was applied
    expect(delays[0]).toBe(10);
    expect(delays[1]).toBe(20);
    expect(delays[2]).toBe(40);
  });

  it("completes a retry chain that succeeds on the last allowed attempt", async () => {
    let attempts = 0;
    const maxAttempts = 8;

    const result = await retry(
      () => {
        attempts += 1;
        if (attempts < maxAttempts) {
          throw makeHttpError(503);
        }
        return Promise.resolve("finally succeeded");
      },
      {
        maxAttempts,
        baseDelayMs: 1,
        jitter: false,
        sleepFn: instantSleep,
      },
    );

    expect(result).toBe("finally succeeded");
    expect(attempts).toBe(maxAttempts);
  });

  it("exhausts a long retry chain with duration cap", async () => {
    let clock = 0;
    const now = () => clock;
    let attempts = 0;

    try {
      await retry(
        () => {
          attempts += 1;
          clock += 5_000; // Each attempt takes 5s
          throw makeHttpError(429);
        },
        {
          maxAttempts: 100,
          maxDurationMs: 30_000,
          baseDelayMs: 100,
          jitter: false,
          now,
          sleepFn: async (ms) => {
            clock += ms;
          },
        },
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(RetryExhaustedError);
      expect((error as RetryExhaustedError).message).toContain("duration");
      // Should have stopped well before 100 attempts
      expect(attempts).toBeLessThan(10);
    }
  });
});

describe("Stress test: agent loop abort during tool execution", () => {
  it("aborts cleanly during a multi-step loop", async () => {
    const registry = new ToolRegistry();
    registry.register(
      createMockTool("tool.slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return "done";
      }),
    );
    const pipeline = new ToolPipeline({ executor: new ToolExecutor(registry) });
    const controller = new AbortController();

    const loop = new AgentLoop({
      maxSteps: 20,
      toolPipeline: pipeline,
      signal: controller.signal,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Run many tools" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 5) {
          controller.abort("user pressed Ctrl+C");
        }
        return {
          type: "tool_calls",
          toolCalls: [createToolCall(`call-${callCount}`, "tool.slow")],
        };
      },
      toolContext,
    );

    expect(result.aborted).toBe(true);
    expect(result.stepsUsed).toBeLessThanOrEqual(5);
  });
});

describe("Stress test: provider loop abort checkpoints", () => {
  it("aborts before first tool execution starts", async () => {
    const controller = new AbortController();
    controller.abort("pre-aborted");

    let executedTools = 0;
    const registry = new ToolRegistry();
    registry.register(createMockTool("tool.abortable", async () => {
      executedTools += 1;
      return "done";
    }));

    const provider: Provider = {
      config: { id: "anthropic", name: "Anthropic", type: "oauth" },
      async chat() {
        throw new Error("not used");
      },
      async *stream(): AsyncIterable<StreamEvent> {
        expect.unreachable("provider stream should not be called when pre-aborted");
      },
      async listModels() {
        return [];
      },
      async validateConnection() {
        return true;
      },
    };

    const loop = new AgentLoop({ signal: controller.signal });
    let doneReason = "";
    for await (const event of loop.runWithProvider({
      provider,
      model: "test-model",
      messages: [{ id: "u1", role: "user", content: "run", createdAt: new Date() }],
      toolExecutor: new ToolExecutor(registry),
      toolContext,
      tools: [createMockTool("tool.abortable", () => "").definition],
      abortSignal: controller.signal,
    })) {
      if (event.type === "done") {
        doneReason = event.terminationReason;
      }
    }

    expect(doneReason).toBe("aborted");
    expect(executedTools).toBe(0);
  });

  it("preserves partial tool results and stops starting new tools after abort", async () => {
    const controller = new AbortController();
    const executedCallIds: string[] = [];

    const provider: Provider = {
      config: { id: "anthropic", name: "Anthropic", type: "oauth" },
      async chat() {
        throw new Error("not used");
      },
      async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
        yield {
          type: "tool_call_start",
          toolCall: { id: "tool-1", name: "tool.abortable", arguments: { value: "a" } },
        };
        yield {
          type: "tool_call_start",
          toolCall: { id: "tool-2", name: "tool.abortable", arguments: { value: "b" } },
        };
        yield {
          type: "done",
          finishReason: "tool_use",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        };
      },
      async listModels() {
        return [];
      },
      async validateConnection() {
        return true;
      },
    };

    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "tool.abortable",
        description: "abortable",
        parameters: { type: "object", properties: {} },
      },
      async execute(_args, context): Promise<ToolResult> {
        executedCallIds.push(`call-${executedCallIds.length + 1}`);
        if (executedCallIds.length === 1) {
          controller.abort("ctrl-c");
        }
        await Bun.sleep(1);
        return {
          callId: "ignored",
          name: "tool.abortable",
          result: context.abortSignal?.aborted ? "partial" : "ok",
        };
      },
    });

    const loop = new AgentLoop({ signal: controller.signal });
    let doneContent: string | ContentBlock[] = "";
    let doneReason = "";
    const emittedStarts: string[] = [];

    for await (const event of loop.runWithProvider({
      provider,
      model: "test-model",
      messages: [{ id: "u1", role: "user", content: "run", createdAt: new Date() }],
      toolExecutor: new ToolExecutor(registry),
      toolContext,
      tools: [createMockTool("tool.abortable", () => "").definition],
      abortSignal: controller.signal,
    })) {
      if (event.type === "tool_call_start") {
        emittedStarts.push(event.toolCall.id);
      }
      if (event.type === "done") {
        doneReason = event.terminationReason;
        doneContent = event.content;
      }
    }

    expect(doneReason).toBe("aborted");
    expect(executedCallIds).toEqual(["call-1"]);
    expect(emittedStarts).toEqual(["tool-1"]);
    expect(Array.isArray(doneContent)).toBe(true);
    if (Array.isArray(doneContent)) {
      const resultBlocks = doneContent.filter((block) => block.type === "tool_result");
      expect(resultBlocks).toHaveLength(1);
      expect(resultBlocks[0]?.tool_use_id).toBe("tool-1");
    }
  });

  it("aborts while waiting on provider stream", async () => {
    const controller = new AbortController();

    const provider: Provider = {
      config: { id: "anthropic", name: "Anthropic", type: "oauth" },
      async chat() {
        throw new Error("not used");
      },
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        while (!request.signal?.aborted) {
          await Bun.sleep(5);
        }
      },
      async listModels() {
        return [];
      },
      async validateConnection() {
        return true;
      },
    };

    setTimeout(() => {
      controller.abort("during-provider-request");
    }, 20);

    const loop = new AgentLoop({ signal: controller.signal });
    let doneReason = "";
    for await (const event of loop.runWithProvider({
      provider,
      model: "test-model",
      messages: [{ id: "u1", role: "user", content: "run", createdAt: new Date() }],
      toolExecutor: new ToolExecutor(new ToolRegistry()),
      toolContext,
      abortSignal: controller.signal,
    })) {
      if (event.type === "done") {
        doneReason = event.terminationReason;
      }
    }

    expect(doneReason).toBe("aborted");
  });
});
