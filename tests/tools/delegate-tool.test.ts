import { describe, expect, it } from "bun:test";

import { DelegateTool, ToolExecutor, ToolRegistry, type DelegateMergeStrategy, type SubAgentResultMerger } from "../../src/tools";
import { DaemonHttpServer } from "../../src/daemon/server";
import { ModelRouter } from "../../src/providers/router";
import { ProviderRegistry } from "../../src/providers/registry";
import type { ProviderAuthService } from "../../src/providers/auth-service";
import type { ToolContext } from "../../src/types";
import type { SubAgentPoolOptions, SubAgentResult, SubAgentTask } from "../../src/harness/sub-agent-pool";

const toolContext: ToolContext = {
  conversationId: "conv-delegate",
  userId: "user-delegate",
  workspaceId: "ws-delegate",
};

interface RecordedCall {
  options?: SubAgentPoolOptions;
  tasks?: SubAgentTask[];
  strategy?: DelegateMergeStrategy;
}

function createStubAuthService(): ProviderAuthService {
  return {
    listProviders: async () => {
      throw new Error("not implemented");
    },
    getProviderAuthStatus: async () => {
      throw new Error("not implemented");
    },
    handleCommand: async () => {
      throw new Error("not implemented");
    },
  } as unknown as ProviderAuthService;
}

function createRecordingMerger(recorded: RecordedCall): SubAgentResultMerger {
  return {
    async merge(strategy: DelegateMergeStrategy, results: SubAgentResult[]): Promise<string> {
      recorded.strategy = strategy;
      return results
        .map((result) => result.output ?? result.error?.message ?? "")
        .filter((value) => value.length > 0)
        .join(" | ");
    },
  };
}

describe("DelegateTool", () => {
  it("exposes delegate definition with expected schema", () => {
    const tool = new DelegateTool();

    expect(tool.definition.name).toBe("delegate");
    expect(tool.definition.parameters.required).toEqual(["tasks", "merge_strategy"]);
    expect(tool.definition.parameters.properties["merge_strategy"]?.enum).toEqual([
      "concat",
      "synthesize",
      "first",
    ]);
  });

  it("executes two tasks through pool and returns merged output", async () => {
    const recorded: RecordedCall = {};
    const tool = new DelegateTool({
      merger: createRecordingMerger(recorded),
      poolFactory: (options) => ({
        async runAll(tasks) {
          recorded.options = options;
          recorded.tasks = tasks;
          return [
            {
              id: tasks[0]?.id ?? "delegate-task-1",
              output: "result-one",
              stepsUsed: 1,
              terminationReason: "text_only_response",
            },
            {
              id: tasks[1]?.id ?? "delegate-task-2",
              output: "result-two",
              stepsUsed: 2,
              terminationReason: "text_only_response",
            },
          ];
        },
      }),
    });

    const result = await tool.execute(
      {
        callId: "delegate-call-1",
        tasks: ["analyze logs", "summarize findings"],
        merge_strategy: "concat",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("result-one | result-two");
    expect(recorded.tasks?.map((task) => task.prompt)).toEqual(["analyze logs", "summarize findings"]);
    expect(recorded.strategy).toBe("concat");
  });

  it("returns clear error when tasks array is empty", async () => {
    const tool = new DelegateTool();

    const result = await tool.execute(
      {
        callId: "delegate-call-2",
        tasks: [],
        merge_strategy: "first",
      },
      toolContext,
    );

    expect(result.error).toBe("'tasks' must include at least one task.");
    expect(result.result).toBeNull();
  });

  it("passes max_concurrent through pool options when provided", async () => {
    const recorded: RecordedCall = {};
    const tool = new DelegateTool({
      merger: createRecordingMerger(recorded),
      poolFactory: (options) => ({
        async runAll(tasks) {
          recorded.options = options;
          return tasks.map((task) => ({
            id: task.id,
            output: task.prompt,
            stepsUsed: 1,
            terminationReason: "text_only_response",
          }));
        },
      }),
    });

    const result = await tool.execute(
      {
        callId: "delegate-call-3",
        tasks: ["task-a", "task-b"],
        merge_strategy: "synthesize",
        max_concurrent: 2,
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(recorded.options?.maxConcurrent).toBe(2);
    expect(recorded.strategy).toBe("synthesize");
  });

  it("registers in ToolRegistry", () => {
    const registry = new ToolRegistry();
    registry.register(new DelegateTool());

    expect(registry.has("delegate")).toBe(true);
    expect(registry.get("delegate")?.definition.name).toBe("delegate");
  });

  it("is registered in daemon server tool initialization", () => {
    const server = new DaemonHttpServer({
      authService: createStubAuthService(),
      modelRouter: new ModelRouter(new ProviderRegistry()),
    });

    const internals = server as unknown as { toolExecutor: ToolExecutor };
    const registry = internals.toolExecutor.getRegistry();

    expect(registry.has("delegate")).toBe(true);
  });
});
