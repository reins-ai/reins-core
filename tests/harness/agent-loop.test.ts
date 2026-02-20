import { describe, expect, it } from "bun:test";

import { AgentLoop, DoomLoopGuard, ToolPipeline } from "../../src/harness";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import type { AgentMessage, LoopEvent, StepResult } from "../../src/harness";
import type { ConversationContext, NudgeInjector } from "../../src/memory/proactive";
import type { ChatRequest, Message, Model, Provider, StreamEvent, Tool, ToolCall, ToolContext, ToolDefinition, ToolResult } from "../../src/types";

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

function createExecutor(toolName: string, handler?: (args: Record<string, unknown>) => unknown): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(
    createMockTool(toolName, (args) => {
      if (handler) {
        return handler(args);
      }

      return {
        ok: true,
        value: args.value,
      };
    }),
  );

  return new ToolExecutor(registry);
}

function createModel(id: string): Model {
  return {
    id,
    name: id,
    provider: "anthropic",
    contextWindow: 4096,
    capabilities: ["chat", "streaming", "tool_use"],
  };
}

function createTwoTurnProvider(): Provider {
  let turn = 0;

  return {
    config: {
      id: "anthropic",
      name: "Anthropic",
      type: "oauth",
    },
    async chat() {
      throw new Error("chat not used in this test");
    },
    async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
      turn += 1;

      if (turn === 1) {
        for (const char of "Working on it.") {
          yield { type: "token", content: char };
        }

        yield {
          type: "tool_call_start",
          toolCall: {
            id: "tool-1",
            name: "notes.create",
            arguments: { value: "draft" },
          },
        };

        yield {
          type: "done",
          usage: { inputTokens: 5, outputTokens: 4, totalTokens: 9 },
          finishReason: "tool_use",
        };
        return;
      }

      for (const char of "Done.") {
        yield { type: "token", content: char };
      }

      yield {
        type: "done",
        usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
        finishReason: "stop",
      };
    },
    async listModels(): Promise<Model[]> {
      return [createModel("anthropic-test-model")];
    },
    async validateConnection(): Promise<boolean> {
      return true;
    },
  };
}

function createMultiToolTurnProvider(): Provider {
  let turn = 0;

  return {
    config: {
      id: "anthropic",
      name: "Anthropic",
      type: "oauth",
    },
    async chat() {
      throw new Error("chat not used in this test");
    },
    async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
      turn += 1;

      if (turn === 1) {
        yield {
          type: "tool_call_start",
          toolCall: {
            id: "tool-1",
            name: "notes.create",
            arguments: { value: "first" },
          },
        };
        yield {
          type: "tool_call_start",
          toolCall: {
            id: "tool-2",
            name: "notes.create",
            arguments: { value: "second" },
          },
        };
        yield {
          type: "done",
          finishReason: "tool_use",
        };
        return;
      }

      for (const char of "All done") {
        yield { type: "token", content: char };
      }

      yield {
        type: "done",
        finishReason: "stop",
      };
    },
    async listModels(): Promise<Model[]> {
      return [createModel("anthropic-test-model")];
    },
    async validateConnection(): Promise<boolean> {
      return true;
    },
  };
}

const harnessToolDefinitions: ToolDefinition[] = [
  {
    name: "notes.create",
    description: "Create note",
    parameters: {
      type: "object",
      properties: {
        value: { type: "string" },
      },
      required: ["value"],
    },
  },
];

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
    expect(result.terminationReason).toBe("text_only_response");
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
    expect(result.terminationReason).toBe("text_only_response");
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
    expect(result.terminationReason).toBe("max_steps_reached");
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
    expect(result.terminationReason).toBe("aborted");
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
    expect(result.terminationReason).toBe("text_only_response");
    expect(executedTools).toBe(2);
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(result.messages[result.messages.length - 1]?.content).toBe("Completed both actions.");
  });

  it("streams multi-turn tool flow and returns tool-aware content blocks", async () => {
    const provider = createTwoTurnProvider();

    const executor = createExecutor("notes.create", () => ({ saved: true }));
    const loop = new AgentLoop();

    const events = [] as Array<{ type: string }>;
    for await (const event of loop.runWithProvider({
      provider,
      model: "anthropic-test-model",
      messages: [{
        id: "msg-user-1",
        role: "user",
        content: "Create the note and confirm",
        createdAt: new Date(),
      } satisfies Message],
      toolExecutor: executor,
      toolContext,
      tools: harnessToolDefinitions,
    })) {
      events.push({ type: event.type });

      if (event.type === "done") {
        expect(event.stepsUsed).toBe(1);
        expect(event.limitReached).toBe(false);
        expect(event.terminationReason).toBe("text_only_response");
        expect(Array.isArray(event.content)).toBe(true);

        if (Array.isArray(event.content)) {
          expect(event.content.some((block) => block.type === "tool_use")).toBe(true);
          expect(event.content.some((block) => block.type === "tool_result")).toBe(true);
        }
      }
    }

    const eventTypes = events.map((event) => event.type);
    const firstToolStart = eventTypes.indexOf("tool_call_start");
    const firstToolEnd = eventTypes.indexOf("tool_call_end");
    const doneIndex = eventTypes.indexOf("done");

    expect(firstToolStart).toBeGreaterThan(-1);
    expect(firstToolEnd).toBeGreaterThan(firstToolStart);
    expect(doneIndex).toBeGreaterThan(firstToolEnd);
  });

  it("applies nudge injector addendum before provider turn", async () => {
    let receivedSystemPrompt = "";
    let receivedContext: ConversationContext | null = null;

    const provider: Provider = {
      config: {
        id: "anthropic",
        name: "Anthropic",
        type: "oauth",
      },
      async chat() {
        throw new Error("chat not used in this test");
      },
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        receivedSystemPrompt = request.systemPrompt ?? "";
        yield { type: "token", content: "Done" };
        yield { type: "done", finishReason: "stop" };
      },
      async listModels(): Promise<Model[]> {
        return [createModel("anthropic-test-model")];
      },
      async validateConnection(): Promise<boolean> {
        return true;
      },
    };

    const loop = new AgentLoop({
      nudgeInjector: {
        injectNudges: async (context, systemPrompt) => {
          receivedContext = context;
          return `${systemPrompt}\n\nNudge addendum: keep responses concise.`;
        },
      } as NudgeInjector,
    });

    const events: LoopEvent[] = [];
    for await (const event of loop.runWithProvider({
      provider,
      model: "anthropic-test-model",
      messages: [{
        id: "msg-user-1",
        role: "user",
        content: "Help me summarize this",
        createdAt: new Date(),
      } satisfies Message],
      toolExecutor: createExecutor("notes.create"),
      toolContext,
      systemPrompt: "Base system prompt",
    })) {
      events.push(event);
    }

    expect(receivedSystemPrompt).toContain("Base system prompt");
    expect(receivedSystemPrompt).toContain("Nudge addendum");
    expect(receivedContext?.query).toBe("Help me summarize this");
    expect(events.some((event) => event.type === "done")).toBe(true);
  });

  it("respects step limit in provider loop mode", async () => {
    const provider = {
      config: { id: "anthropic", name: "Anthropic", type: "oauth" as const },
      async chat() {
        throw new Error("chat not used in this test");
      },
      async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
        yield { type: "token", content: "A" };
        yield {
          type: "tool_call_start",
          toolCall: { id: "tool-1", name: "notes.create", arguments: { value: "again" } },
        };
        yield {
          type: "done",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          finishReason: "tool_use",
        };
      },
      async listModels(): Promise<Model[]> {
        return [createModel("anthropic-test-model")];
      },
      async validateConnection(): Promise<boolean> {
        return true;
      },
    };

    const loop = new AgentLoop({ maxSteps: 0 });
    const executor = createExecutor("notes.create");

    let terminalReason = "";
    for await (const event of loop.runWithProvider({
      provider,
      model: "anthropic-test-model",
      messages: [{ id: "msg-user-1", role: "user", content: "Do work", createdAt: new Date() }],
      toolExecutor: executor,
      toolContext,
      tools: harnessToolDefinitions,
    })) {
      if (event.type === "done") {
        terminalReason = event.finishReason;
        expect(event.limitReached).toBe(true);
        expect(event.terminationReason).toBe("max_steps_reached");
      }
    }

    expect(terminalReason).toBe("step_limit");
  });

  it("stops provider loop when doom-loop guard detects repeated tool calls", async () => {
    const provider = {
      config: { id: "anthropic", name: "Anthropic", type: "oauth" as const },
      async chat() {
        throw new Error("chat not used in this test");
      },
      async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
        yield {
          type: "tool_call_start",
          toolCall: { id: crypto.randomUUID(), name: "notes.create", arguments: { value: "repeat" } },
        };
        yield {
          type: "done",
          finishReason: "tool_use",
        };
      },
      async listModels(): Promise<Model[]> {
        return [createModel("anthropic-test-model")];
      },
      async validateConnection(): Promise<boolean> {
        return true;
      },
    };

    const guard = new DoomLoopGuard({
      repetitionThreshold: 3,
      windowSize: 10,
      maxConsecutiveFailures: 100,
      maxTotalFailures: 100,
    });
    const loop = new AgentLoop({ doomLoopGuard: guard, maxSteps: 20 });
    const executor = createExecutor("notes.create");

    let terminalReason = "";
    let terminationReason = "";
    let stepsUsed = -1;
    for await (const event of loop.runWithProvider({
      provider,
      model: "anthropic-test-model",
      messages: [{ id: "msg-user-1", role: "user", content: "Repeat", createdAt: new Date() }],
      toolExecutor: executor,
      toolContext,
      tools: harnessToolDefinitions,
    })) {
      if (event.type === "done") {
        terminalReason = event.finishReason;
        terminationReason = event.terminationReason;
        stepsUsed = event.stepsUsed;
      }
    }

    expect(terminalReason).toBe("doom_loop");
    expect(terminationReason).toBe("doom_loop_detected");
    expect(stepsUsed).toBe(3);
  });

  it("executes multiple provider tool calls in parallel and appends ordered tool results", async () => {
    const provider = createMultiToolTurnProvider();
    const executor = createExecutor("notes.create", async (args) => {
      if (args.value === "first") {
        await new Promise((resolve) => setTimeout(resolve, 60));
      } else {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }

      return { value: args.value };
    });
    const loop = new AgentLoop();

    let doneContent: string | Message["content"] | undefined;
    const startedAt = Date.now();
    for await (const event of loop.runWithProvider({
      provider,
      model: "anthropic-test-model",
      messages: [{ id: "msg-user-1", role: "user", content: "Run both", createdAt: new Date() }],
      toolExecutor: executor,
      toolContext,
      tools: harnessToolDefinitions,
    })) {
      if (event.type === "done") {
        doneContent = event.content;
      }
    }
    const elapsedMs = Date.now() - startedAt;

    expect(Array.isArray(doneContent)).toBe(true);
    if (Array.isArray(doneContent)) {
      const toolResultBlocks = doneContent.filter((block) => block.type === "tool_result");
      expect(toolResultBlocks).toHaveLength(2);
      expect(toolResultBlocks[0]?.tool_use_id).toBe("tool-1");
      expect(toolResultBlocks[1]?.tool_use_id).toBe("tool-2");
    }

    expect(elapsedMs).toBeLessThan(110);
  });
});
