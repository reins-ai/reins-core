import { describe, expect, it } from "bun:test";

import { AgentLoop, ToolPipeline } from "../../src/harness";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { AgentMessage, StepResult } from "../../src/harness";
import type { Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-agent-loop",
  userId: "user-agent-loop",
  workspaceId: "ws-agent-loop",
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

function createToolCall(id: string, name: string, value: string): ToolCall {
  return {
    id,
    name,
    arguments: { value },
  };
}

function createPipeline(toolName: string, onExecute?: () => void): ToolPipeline {
  const registry = new ToolRegistry();
  registry.register(
    createMockTool(toolName, (args) => {
      onExecute?.();
      return {
        ok: true,
        value: args.value,
      };
    }),
  );

  return new ToolPipeline({
    executor: new ToolExecutor(registry),
  });
}

describe("AgentLoop", () => {
  it("returns immediately for a text-only response without consuming steps", async () => {
    const loop = new AgentLoop();
    const initialMessages: AgentMessage[] = [{ role: "user", content: "Hello" }];

    const result = await loop.run(
      initialMessages,
      async (): Promise<StepResult> => ({
        type: "text",
        content: "Hi there",
        done: true,
      }),
      toolContext,
    );

    expect(result.stepsUsed).toBe(0);
    expect(result.limitReached).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual({ role: "assistant", content: "Hi there" });
  });

  it("runs a tool round then finishes on text response", async () => {
    const pipeline = createPipeline("notes.create");
    const loop = new AgentLoop({ toolPipeline: pipeline });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Create a note" }],
      async (): Promise<StepResult> => {
        callCount += 1;
        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-1", "notes.create", "Buy milk")],
          };
        }

        return {
          type: "text",
          content: "Done. I created your note.",
          done: true,
        };
      },
      toolContext,
    );

    expect(result.stepsUsed).toBe(1);
    expect(result.limitReached).toBe(false);
    expect(result.aborted).toBe(false);
    expect(result.messages.some((message) => message.role === "tool")).toBe(true);
    expect(result.messages[result.messages.length - 1]?.content).toBe("Done. I created your note.");
  });

  it("enforces max steps and requests forced text-only completion", async () => {
    let executedTools = 0;
    const pipeline = createPipeline("notes.create", () => {
      executedTools += 1;
    });

    const loop = new AgentLoop({ maxSteps: 1, toolPipeline: pipeline });

    const seenToolsDisabled: boolean[] = [];
    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Do several actions" }],
      async (_messages, options): Promise<StepResult> => {
        seenToolsDisabled.push(Boolean(options.toolsDisabled));
        callCount += 1;

        if (options.toolsDisabled) {
          return {
            type: "text",
            content: "I reached the tool step limit and stopped further tool calls.",
            done: true,
          };
        }

        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-1", "notes.create", "first")],
          };
        }

        return {
          type: "tool_calls",
          toolCalls: [createToolCall("call-2", "notes.create", "second")],
        };
      },
      toolContext,
    );

    expect(result.stepsUsed).toBe(1);
    expect(result.limitReached).toBe(true);
    expect(result.aborted).toBe(false);
    expect(executedTools).toBe(1);
    expect(seenToolsDisabled.includes(true)).toBe(true);
    expect(result.messages[result.messages.length - 1]?.content).toBe(
      "I reached the tool step limit and stopped further tool calls.",
    );
  });

  it("stops immediately when abort signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort("cancelled");

    const loop = new AgentLoop({ signal: controller.signal });

    let stepCalls = 0;
    const result = await loop.run(
      [{ role: "user", content: "Hello" }],
      async (): Promise<StepResult> => {
        stepCalls += 1;
        return { type: "text", content: "should not execute" };
      },
      toolContext,
    );

    expect(stepCalls).toBe(0);
    expect(result.aborted).toBe(true);
    expect(result.stepsUsed).toBe(0);
    expect(result.messages).toHaveLength(1);
  });

  it("supports multiple tool rounds before final text response", async () => {
    let executedTools = 0;
    const pipeline = createPipeline("notes.create", () => {
      executedTools += 1;
    });
    const loop = new AgentLoop({ toolPipeline: pipeline });

    let callCount = 0;
    const result = await loop.run(
      [{ role: "user", content: "Do two tool actions then summarize" }],
      async (): Promise<StepResult> => {
        callCount += 1;

        if (callCount === 1) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-1", "notes.create", "first")],
          };
        }

        if (callCount === 2) {
          return {
            type: "tool_calls",
            toolCalls: [createToolCall("call-2", "notes.create", "second")],
          };
        }

        return {
          type: "text",
          content: "Completed both actions.",
          done: true,
        };
      },
      toolContext,
    );

    expect(result.stepsUsed).toBe(2);
    expect(result.limitReached).toBe(false);
    expect(result.aborted).toBe(false);
    expect(executedTools).toBe(2);
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(result.messages[result.messages.length - 1]?.content).toBe("Completed both actions.");
  });
});
