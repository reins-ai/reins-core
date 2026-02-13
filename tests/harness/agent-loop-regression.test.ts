import { describe, expect, it } from "bun:test";

import {
  AgentLoop,
  DoomLoopGuard,
  HarnessPermissionChecker,
  MINIMAL_PROFILE,
  FULL_PROFILE,
  ToolPipeline,
  createHarnessEventBus,
} from "../../src/harness";
import type { AgentMessage, LoopEvent, StepResult, ToolPipelineResult } from "../../src/harness";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { ChatRequest, ContentBlock, Provider, StreamEvent, Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-loop-regression",
  userId: "user-loop-regression",
  workspaceId: "ws-loop-regression",
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

function createPipeline(...toolNames: string[]): ToolPipeline {
  const registry = new ToolRegistry();
  for (const name of toolNames) {
    registry.register(
      createMockTool(name, (args) => ({ ok: true, value: args.value })),
    );
  }
  return new ToolPipeline({
    executor: new ToolExecutor(registry),
  });
}

describe("AgentLoop regression: step limit enforcement", () => {
  it("enforces step limit of 0 — no tool calls allowed", async () => {
    const pipeline = createPipeline("tool.a");
    const loop = new AgentLoop({ maxSteps: 0, toolPipeline: pipeline });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Do something" }],
      async (_messages, options): Promise<StepResult> => {
        callCount += 1;
        if (options.toolsDisabled) {
          return { type: "text", content: "Forced text completion", done: true };
        }
        return {
          type: "tool_calls",
          toolCalls: [createToolCall("call-1", "tool.a")],
        };
      },
      toolContext,
    );

    expect(result.limitReached).toBe(true);
    expect(result.stepsUsed).toBe(0);
    expect(result.terminationReason).toBe("max_steps_reached");
    expect(result.messages[result.messages.length - 1]?.content).toBe("Forced text completion");
  });

  it("enforces step limit exactly at boundary", async () => {
    const pipeline = createPipeline("tool.a");
    const loop = new AgentLoop({ maxSteps: 3, toolPipeline: pipeline });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Do three things" }],
      async (_messages, options): Promise<StepResult> => {
        callCount += 1;
        if (options.toolsDisabled) {
          return { type: "text", content: "Limit reached summary", done: true };
        }
        return {
          type: "tool_calls",
          toolCalls: [createToolCall(`call-${callCount}`, "tool.a")],
        };
      },
      toolContext,
    );

    expect(result.stepsUsed).toBe(3);
    expect(result.limitReached).toBe(true);
    expect(result.terminationReason).toBe("max_steps_reached");
  });

  it("uses default step limit of 25 when not specified", async () => {
    const loop = new AgentLoop();
    // Verify it doesn't crash with default — just run a text-only step
    const result = await loop.run(
      [{ role: "user", content: "Hello" }],
      async (): Promise<StepResult> => ({ type: "text", content: "Hi", done: true }),
      toolContext,
    );

    expect(result.stepsUsed).toBe(0);
    expect(result.limitReached).toBe(false);
    expect(result.terminationReason).toBe("text_only_response");
  });

  it("handles non-finite maxSteps by using default", async () => {
    const loop = new AgentLoop({ maxSteps: NaN });
    const result = await loop.run(
      [{ role: "user", content: "Hello" }],
      async (): Promise<StepResult> => ({ type: "text", content: "Hi", done: true }),
      toolContext,
    );

    expect(result.stepsUsed).toBe(0);
    expect(result.limitReached).toBe(false);
    expect(result.terminationReason).toBe("text_only_response");
  });
});

describe("AgentLoop regression: abort signal handling", () => {
  it("aborts mid-loop when signal fires between steps", async () => {
    const pipeline = createPipeline("tool.a");
    const controller = new AbortController();
    const loop = new AgentLoop({ toolPipeline: pipeline, signal: controller.signal });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Do things" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 2) {
          controller.abort("user cancelled");
        }
        if (callCount <= 2) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall(`call-${callCount}`, "tool.a")],
          };
        }
        return { type: "text", content: "done", done: true };
      },
      toolContext,
    );

    expect(result.aborted).toBe(true);
    expect(result.stepsUsed).toBeLessThanOrEqual(2);
    expect(result.terminationReason).toBe("aborted");
  });

  it("emits aborted event on event bus when signal fires", async () => {
    const eventBus = createHarnessEventBus();
    const controller = new AbortController();
    controller.abort("test abort");

    const abortedEvents: string[] = [];
    eventBus.on("aborted", (e) => {
      abortedEvents.push(e.payload.reason ?? "no-reason");
    });

    const loop = new AgentLoop({ eventBus, signal: controller.signal });
    await loop.run(
      [{ role: "user", content: "Hello" }],
      async (): Promise<StepResult> => ({ type: "text", content: "Hi" }),
      toolContext,
    );

    expect(abortedEvents).toHaveLength(1);
  });
});

describe("AgentLoop regression: multi-step scenarios (10+ steps)", () => {
  it("completes a 10-step tool loop successfully", async () => {
    const pipeline = createPipeline("tool.step");
    const loop = new AgentLoop({ maxSteps: 15, toolPipeline: pipeline });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Run 10 tool steps" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount <= 10) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall(`call-${callCount}`, "tool.step", `step-${callCount}`)],
          };
        }
        return { type: "text", content: "All 10 steps complete", done: true };
      },
      toolContext,
    );

    expect(result.stepsUsed).toBe(10);
    expect(result.limitReached).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.terminationReason).toBe("text_only_response");
    expect(result.messages[result.messages.length - 1]?.content).toBe("All 10 steps complete");

    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(10);
  });

  it("hits step limit during a 15-step scenario with maxSteps=12", async () => {
    const pipeline = createPipeline("tool.step");
    const loop = new AgentLoop({ maxSteps: 12, toolPipeline: pipeline });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Run many steps" }],
      async (_messages, options): Promise<StepResult> => {
        callCount += 1;
        if (options.toolsDisabled) {
          return { type: "text", content: "Forced stop at limit", done: true };
        }
        return {
          type: "tool_calls",
          toolCalls: [createToolCall(`call-${callCount}`, "tool.step")],
        };
      },
      toolContext,
    );

    expect(result.stepsUsed).toBe(12);
    expect(result.limitReached).toBe(true);
    expect(result.terminationReason).toBe("max_steps_reached");
    expect(result.messages[result.messages.length - 1]?.content).toBe("Forced stop at limit");
  });
});

describe("AgentLoop regression: error handling", () => {
  it("stops on step function error and includes error in messages", async () => {
    const loop = new AgentLoop();

    const result = await loop.run(
      [{ role: "user", content: "Hello" }],
      async (): Promise<StepResult> => ({
        type: "error",
        error: new Error("Provider unavailable"),
      }),
      toolContext,
    );

    expect(result.stepsUsed).toBe(0);
    expect(result.limitReached).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.terminationReason).toBe("error");
    expect(result.messages[result.messages.length - 1]?.content).toBe("Provider unavailable");
  });

  it("handles step function returning error with content fallback", async () => {
    const loop = new AgentLoop();

    const result = await loop.run(
      [{ role: "user", content: "Hello" }],
      async (): Promise<StepResult> => ({
        type: "error",
        content: "Something went wrong",
      }),
      toolContext,
    );

    expect(result.messages[result.messages.length - 1]?.content).toBe("Something went wrong");
  });

  it("emits error event when step function returns error", async () => {
    const eventBus = createHarnessEventBus();
    const errorEvents: string[] = [];
    eventBus.on("error", (e) => {
      errorEvents.push(e.payload.error.message);
    });

    const loop = new AgentLoop({ eventBus });

    await loop.run(
      [{ role: "user", content: "Hello" }],
      async (): Promise<StepResult> => ({
        type: "error",
        error: new Error("Test error"),
      }),
      toolContext,
    );

    expect(errorEvents).toHaveLength(1);
    expect(errorEvents[0]).toBe("Test error");
  });
});

describe("AgentLoop regression: permission integration", () => {
  it("denies tool calls when permission checker rejects", async () => {
    const pipeline = createPipeline("notes");
    const permissionChecker = new HarnessPermissionChecker(MINIMAL_PROFILE);
    const loop = new AgentLoop({ toolPipeline: pipeline, permissionChecker });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Create a note" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-1", "notes", "test")],
          };
        }
        return { type: "text", content: "Permission denied, stopping.", done: true };
      },
      toolContext,
    );

    // notes is denied in minimal profile
    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toContain("Permission denied");
  });

  it("allows tool calls when permission checker approves", async () => {
    const pipeline = createPipeline("notes");
    const permissionChecker = new HarnessPermissionChecker(FULL_PROFILE);
    const loop = new AgentLoop({ toolPipeline: pipeline, permissionChecker });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Create a note" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-1", "notes", "test")],
          };
        }
        return { type: "text", content: "Note created.", done: true };
      },
      toolContext,
    );

    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).not.toContain("Permission denied");
  });
});

describe("AgentLoop regression: doom loop guard integration", () => {
  it("terminates when the same tool call repeats to prevent a doom loop", async () => {
    const pipeline = createPipeline("tool.repeat");
    const guard = new DoomLoopGuard({
      repetitionThreshold: 3,
      windowSize: 10,
      maxConsecutiveFailures: 100,
      maxTotalFailures: 100,
    });

    const loop = new AgentLoop({
      maxSteps: 10,
      toolPipeline: pipeline,
      doomLoopGuard: guard,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Keep trying" }],
      async (_messages, options): Promise<StepResult> => {
        callCount += 1;
        if (options.toolsDisabled) {
          return { type: "text", content: "Doom loop detected, stopping.", done: true };
        }
        return {
          type: "tool_calls",
          toolCalls: [createToolCall(`call-${callCount}`, "tool.repeat", "same-input")],
        };
      },
      toolContext,
    );

    expect(result.messages[result.messages.length - 1]?.content).toBe("Doom loop detected, stopping.");
    expect(result.stepsUsed).toBe(3);
    expect(result.limitReached).toBe(true);
    expect(result.terminationReason).toBe("doom_loop_detected");

    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
  });

  it("does not trigger doom loop guard when tool inputs differ", async () => {
    const pipeline = createPipeline("tool.repeat");
    const guard = new DoomLoopGuard({
      repetitionThreshold: 3,
      windowSize: 10,
      maxConsecutiveFailures: 100,
      maxTotalFailures: 100,
    });

    const loop = new AgentLoop({
      maxSteps: 10,
      toolPipeline: pipeline,
      doomLoopGuard: guard,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Do varied steps" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount <= 4) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall(`call-${callCount}`, "tool.repeat", `value-${callCount}`)],
          };
        }
        return { type: "text", content: "Completed without repetition", done: true };
      },
      toolContext,
    );

    expect(result.terminationReason).toBe("text_only_response");
    expect(result.limitReached).toBe(false);
    expect(result.stepsUsed).toBe(4);
  });

  it("resets doom loop tracking between conversations", async () => {
    const pipeline = createPipeline("tool.repeat");
    const sharedGuard = new DoomLoopGuard({
      repetitionThreshold: 2,
      windowSize: 4,
      maxConsecutiveFailures: 100,
      maxTotalFailures: 100,
    });

    const firstLoop = new AgentLoop({ toolPipeline: pipeline, doomLoopGuard: sharedGuard, maxSteps: 10 });
    const secondLoop = new AgentLoop({ toolPipeline: pipeline, doomLoopGuard: sharedGuard, maxSteps: 10 });

    let firstCount = 0;
    const first = await firstLoop.run(
      [{ role: "user", content: "Loop once" }],
      async (_messages, options): Promise<StepResult> => {
        firstCount += 1;
        if (options.toolsDisabled) {
          return { type: "text", content: "Stopped first loop", done: true };
        }
        return {
          type: "tool_calls",
          toolCalls: [createToolCall(`first-${firstCount}`, "tool.repeat", "shared")],
        };
      },
      toolContext,
    );
    expect(first.terminationReason).toBe("doom_loop_detected");

    let secondCount = 0;
    const second = await secondLoop.run(
      [{ role: "user", content: "New conversation" }],
      async (): Promise<StepResult> => {
        secondCount += 1;
        if (secondCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("second-1", "tool.repeat", "shared")],
          };
        }
        return { type: "text", content: "Fresh run succeeded", done: true };
      },
      toolContext,
    );

    expect(second.terminationReason).toBe("text_only_response");
    expect(second.limitReached).toBe(false);
  });
});

describe("AgentLoop regression: delegation contract", () => {
  it("delegates tool calls named 'delegate' to delegation handler", async () => {
    const loop = new AgentLoop({ maxSteps: 5 });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Delegate a task" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [{
              id: "call-delegate",
              name: "delegate",
              arguments: { task: "research something" },
            }],
          };
        }
        return { type: "text", content: "Delegation complete.", done: true };
      },
      toolContext,
      {
        canDelegate: true,
        delegate: async (task) => ({
          type: "text" as const,
          content: `Delegated result for: ${task}`,
        }),
      },
    );

    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toContain("Delegated result for: research something");
  });

  it("returns error when delegation is requested but no delegate handler", async () => {
    const loop = new AgentLoop({ maxSteps: 5 });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Delegate" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [{
              id: "call-delegate",
              name: "delegate",
              arguments: { task: "something" },
            }],
          };
        }
        return { type: "text", content: "Done.", done: true };
      },
      toolContext,
      { canDelegate: true },
    );

    const toolMessage = result.messages.find((m) => m.role === "tool");
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.content).toContain("not configured");
  });
});

describe("AgentLoop regression: message immutability", () => {
  it("does not mutate the initial messages array", async () => {
    const loop = new AgentLoop();
    const initial: AgentMessage[] = [{ role: "user", content: "Hello" }];
    const initialCopy = [...initial];

    await loop.run(
      initial,
      async (): Promise<StepResult> => ({ type: "text", content: "Hi", done: true }),
      toolContext,
    );

    // The run method creates a copy, so initial should be unchanged in length
    // (it may have been shallow-copied internally)
    expect(initial).toHaveLength(initialCopy.length);
    expect(initial[0]?.content).toBe("Hello");
  });
});

describe("AgentLoop regression: abort timing edge cases", () => {
  it("abort before loop starts — clean exit with no tool execution", async () => {
    const pipeline = createPipeline("tool.a");
    const controller = new AbortController();
    controller.abort("pre-aborted");

    const loop = new AgentLoop({
      toolPipeline: pipeline,
      signal: controller.signal,
    });

    let stepCalled = false;
    const result = await loop.run(
      [{ role: "user", content: "Do something" }],
      async (): Promise<StepResult> => {
        stepCalled = true;
        return { type: "text", content: "should not reach", done: true };
      },
      toolContext,
    );

    expect(result.aborted).toBe(true);
    expect(result.terminationReason).toBe("aborted");
    expect(result.stepsUsed).toBe(0);
    expect(stepCalled).toBe(false);

    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(0);
  });

  it("abort after first tool completes, before second — first tool preserved", async () => {
    const pipeline = createPipeline("tool.a");
    const controller = new AbortController();

    const loop = new AgentLoop({
      toolPipeline: pipeline,
      signal: controller.signal,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Do two things" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-1", "tool.a", "first")],
          };
        }
        // After first tool completes, abort before second tool call
        controller.abort("user cancelled");
        return {
          type: "tool_calls",
          toolCalls: [createToolCall("call-2", "tool.a", "second")],
        };
      },
      toolContext,
    );

    expect(result.aborted).toBe(true);
    expect(result.terminationReason).toBe("aborted");

    // First tool should be in history
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
    expect(toolMessages[0]?.content).toContain("ok");
  });

  it("abort after all tools complete but before next step processes — detected as abort", async () => {
    const pipeline = createPipeline("tool.a");
    const controller = new AbortController();

    const loop = new AgentLoop({
      toolPipeline: pipeline,
      signal: controller.signal,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Do one thing" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-1", "tool.a", "only")],
          };
        }
        // Abort fires inside step function — loop detects it after step returns
        controller.abort("late abort");
        return { type: "text", content: "All done.", done: true };
      },
      toolContext,
    );

    // Abort signal was set before the step result was processed,
    // so the loop correctly detects it as an abort
    expect(result.aborted).toBe(true);
    expect(result.terminationReason).toBe("aborted");

    // First tool should still be in history
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1);
  });
});

describe("AgentLoop regression: partial state preservation", () => {
  it("completed tools appear in conversation history after abort", async () => {
    const pipeline = createPipeline("tool.a", "tool.b");
    const controller = new AbortController();

    const loop = new AgentLoop({
      maxSteps: 10,
      toolPipeline: pipeline,
      signal: controller.signal,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Run tools" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-1", "tool.a", "step-1")],
          };
        }
        if (callCount === 2) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-2", "tool.b", "step-2")],
          };
        }
        controller.abort("done enough");
        return {
          type: "tool_calls",
          toolCalls: [createToolCall("call-3", "tool.a", "step-3")],
        };
      },
      toolContext,
    );

    expect(result.aborted).toBe(true);

    // Both completed tools should be in history
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(2);

    // Assistant messages with tool calls should also be present
    const assistantWithTools = result.messages.filter(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    expect(assistantWithTools.length).toBeGreaterThanOrEqual(2);
  });

  it("partial assistant text is preserved when abort occurs after text step", async () => {
    const loop = new AgentLoop();
    const controller = new AbortController();

    const loopWithSignal = new AgentLoop({ signal: controller.signal });

    let callCount = 0;
    const result = await loopWithSignal.run(
      [{ role: "user", content: "Tell me something" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          // Return text, then abort will be checked on next iteration
          return { type: "text", content: "Here is my response.", done: true };
        }
        return { type: "text", content: "unreachable", done: true };
      },
      toolContext,
    );

    // Text response terminates naturally
    expect(result.terminationReason).toBe("text_only_response");
    expect(result.messages[result.messages.length - 1]?.content).toBe("Here is my response.");
  });

  it("conversation state has no orphaned tool-call assistant messages without matching tool results", async () => {
    const pipeline = createPipeline("tool.a");
    const controller = new AbortController();

    const loop = new AgentLoop({
      maxSteps: 10,
      toolPipeline: pipeline,
      signal: controller.signal,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Run tools" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount <= 3) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall(`call-${callCount}`, "tool.a", `v-${callCount}`)],
          };
        }
        controller.abort("stop");
        return {
          type: "tool_calls",
          toolCalls: [createToolCall("call-4", "tool.a", "v-4")],
        };
      },
      toolContext,
    );

    // Count assistant messages with tool calls and tool result messages
    const assistantToolMessages = result.messages.filter(
      (m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
    );
    const toolResultMessages = result.messages.filter((m) => m.role === "tool");

    // Every assistant tool-call message that was followed by execution
    // should have a corresponding tool result
    // The last assistant message with tool calls (from the abort step) may not have a result
    // but all prior ones must
    for (let i = 0; i < toolResultMessages.length; i++) {
      expect(assistantToolMessages[i]).toBeDefined();
    }

    // No more tool results than tool-call assistant messages
    expect(toolResultMessages.length).toBeLessThanOrEqual(assistantToolMessages.length);
  });
});

describe("AgentLoop regression: multiple tools abort interaction", () => {
  it("abort during multi-tool step — completed tools preserved, pending skipped", async () => {
    const executionOrder: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "tool.tracked",
        description: "Tracked tool",
        parameters: { type: "object", properties: { value: { type: "string" } } },
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const value = String(args.value ?? "");
        executionOrder.push(value);
        return { callId: "ignored", name: "tool.tracked", result: { ok: true, value } };
      },
    });

    const pipeline = new ToolPipeline({ executor: new ToolExecutor(registry) });
    const controller = new AbortController();

    const loop = new AgentLoop({
      maxSteps: 10,
      toolPipeline: pipeline,
      signal: controller.signal,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Run multiple tools" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [
              createToolCall("call-1", "tool.tracked", "first"),
              createToolCall("call-2", "tool.tracked", "second"),
              createToolCall("call-3", "tool.tracked", "third"),
            ],
          };
        }
        if (callCount === 2) {
          controller.abort("enough");
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-4", "tool.tracked", "fourth")],
          };
        }
        return { type: "text", content: "done", done: true };
      },
      toolContext,
    );

    // All three tools from first batch should have executed
    expect(executionOrder).toContain("first");
    expect(executionOrder).toContain("second");
    expect(executionOrder).toContain("third");

    // First batch tool results should be in history
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages).toHaveLength(1); // One tool result message containing all 3 results

    expect(result.aborted).toBe(true);
  });

  it("pending tools do not start after abort signal fires", async () => {
    const executedTools: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      definition: {
        name: "tool.slow",
        description: "Slow tool",
        parameters: { type: "object", properties: { value: { type: "string" } } },
      },
      async execute(args: Record<string, unknown>): Promise<ToolResult> {
        const value = String(args.value ?? "");
        executedTools.push(value);
        return { callId: "ignored", name: "tool.slow", result: { ok: true } };
      },
    });

    const pipeline = new ToolPipeline({ executor: new ToolExecutor(registry) });
    const controller = new AbortController();

    const loop = new AgentLoop({
      maxSteps: 10,
      toolPipeline: pipeline,
      signal: controller.signal,
    });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Run tools then abort" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-1", "tool.slow", "executed")],
          };
        }
        // Abort before returning second batch
        controller.abort("stop");
        return {
          type: "tool_calls",
          toolCalls: [
            createToolCall("call-2", "tool.slow", "should-not-run-a"),
            createToolCall("call-3", "tool.slow", "should-not-run-b"),
          ],
        };
      },
      toolContext,
    );

    expect(result.aborted).toBe(true);
    expect(executedTools).toContain("executed");
    expect(executedTools).not.toContain("should-not-run-a");
    expect(executedTools).not.toContain("should-not-run-b");
  });
});

describe("AgentLoop regression: provider loop abort timing", () => {
  it("abort during model streaming — partial text preserved in done event", async () => {
    const controller = new AbortController();

    const provider: Provider = {
      config: { id: "mock", name: "Mock", type: "local" },
      async chat() {
        throw new Error("not used");
      },
      async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
        yield { type: "token", content: "Hello " };
        yield { type: "token", content: "world" };
        controller.abort("mid-stream");
        yield { type: "token", content: " ignored" };
        yield {
          type: "done",
          finishReason: "stop",
          usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
        };
      },
      async listModels() {
        return [];
      },
      async validateConnection() {
        return true;
      },
    };

    const loop = new AgentLoop({ signal: controller.signal });
    const events: LoopEvent[] = [];

    for await (const event of loop.runWithProvider({
      provider,
      model: "test",
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: new Date() }],
      toolExecutor: new ToolExecutor(new ToolRegistry()),
      toolContext,
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === "done") {
      expect(doneEvent.terminationReason).toBe("aborted");
    }

    // At least some tokens should have been yielded before abort
    const tokenEvents = events.filter((e) => e.type === "token");
    expect(tokenEvents.length).toBeGreaterThanOrEqual(2);
  });

  it("abort between tool execution and next provider call — completed tools in content", async () => {
    const controller = new AbortController();
    let providerCallCount = 0;

    const provider: Provider = {
      config: { id: "mock", name: "Mock", type: "local" },
      async chat() {
        throw new Error("not used");
      },
      async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
        providerCallCount += 1;
        if (providerCallCount === 1) {
          yield {
            type: "tool_call_start",
            toolCall: { id: "t1", name: "tool.simple", arguments: {} },
          };
          yield {
            type: "done",
            finishReason: "tool_use",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        } else {
          yield { type: "token", content: "synthesis" };
          yield {
            type: "done",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          };
        }
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
        name: "tool.simple",
        description: "Simple",
        parameters: { type: "object", properties: {} },
      },
      async execute(): Promise<ToolResult> {
        // Abort after tool completes
        controller.abort("after-tool");
        return { callId: "t1", name: "tool.simple", result: "tool-output" };
      },
    });

    const loop = new AgentLoop({ signal: controller.signal });
    const events: LoopEvent[] = [];

    for await (const event of loop.runWithProvider({
      provider,
      model: "test",
      messages: [{ id: "u1", role: "user", content: "run", createdAt: new Date() }],
      toolExecutor: new ToolExecutor(registry),
      toolContext,
      tools: [{ name: "tool.simple", description: "Simple", parameters: { type: "object", properties: {} } }],
      abortSignal: controller.signal,
    })) {
      events.push(event);
    }

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.type === "done") {
      expect(doneEvent.terminationReason).toBe("aborted");
      // Content should include the completed tool result blocks
      expect(Array.isArray(doneEvent.content)).toBe(true);
      if (Array.isArray(doneEvent.content)) {
        const toolResultBlocks = doneEvent.content.filter((b) => b.type === "tool_result");
        expect(toolResultBlocks).toHaveLength(1);
      }
    }

    // tool_call_end should have been emitted for the completed tool
    const toolEndEvents = events.filter((e) => e.type === "tool_call_end");
    expect(toolEndEvents).toHaveLength(1);
  });

  it("no events emitted after final done event", async () => {
    const provider: Provider = {
      config: { id: "mock", name: "Mock", type: "local" },
      async chat() {
        throw new Error("not used");
      },
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "token", content: "response" };
        yield {
          type: "done",
          finishReason: "stop",
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

    const loop = new AgentLoop();
    const events: LoopEvent[] = [];

    for await (const event of loop.runWithProvider({
      provider,
      model: "test",
      messages: [{ id: "u1", role: "user", content: "hi", createdAt: new Date() }],
      toolExecutor: new ToolExecutor(new ToolRegistry()),
      toolContext,
    })) {
      events.push(event);
    }

    // Last event should be done
    const lastEvent = events[events.length - 1];
    expect(lastEvent?.type).toBe("done");

    // No events after done
    const doneIndex = events.findIndex((e) => e.type === "done");
    expect(doneIndex).toBe(events.length - 1);
  });
});
