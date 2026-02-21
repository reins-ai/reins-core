import { describe, expect, it } from "bun:test";

import { AgentLoop, createHarnessEventBus } from "../../src/harness";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import { ContextManager } from "../../src/context/manager";
import { DropOldestStrategy, estimateConversationTokens } from "../../src/context";
import type { CompactionEventPayload, HarnessEventMap } from "../../src/harness/events";
import type { EventEnvelope } from "../../src/harness/events";
import type { LoopEvent } from "../../src/harness/agent-loop";
import type {
  ChatRequest,
  ChatResponse,
  Message,
  Model,
  Provider,
  StreamEvent,
  Tool,
  ToolContext,
  ToolResult,
} from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-compaction",
  userId: "user-compaction",
  workspaceId: "ws-compaction",
};

function createModel(id: string): Model {
  return {
    id,
    name: id,
    provider: "anthropic",
    contextWindow: 4096,
    capabilities: ["chat", "streaming", "tool_use"],
  };
}

function createMockTool(name: string): Tool {
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
        result: args.value,
      };
    },
  };
}

function createExecutor(toolName: string): ToolExecutor {
  const registry = new ToolRegistry();
  registry.register(createMockTool(toolName));
  return new ToolExecutor(registry);
}

/**
 * Build a set of messages whose estimated token count exceeds a given
 * fraction of `maxTokens`.  Each message is a user/assistant pair with
 * enough text to push the total past the threshold.
 */
function buildHighUtilisationMessages(maxTokens: number, targetUtilisation: number): Message[] {
  const targetTokens = Math.ceil(maxTokens * targetUtilisation);
  const messages: Message[] = [];
  let index = 0;

  while (estimateConversationTokens(messages) < targetTokens) {
    const filler = "x".repeat(200);
    messages.push({
      id: `msg-user-${index}`,
      role: "user",
      content: `Question ${index}: ${filler}`,
      createdAt: new Date(),
    });
    messages.push({
      id: `msg-assistant-${index}`,
      role: "assistant",
      content: `Answer ${index}: ${filler}`,
      createdAt: new Date(),
    });
    index += 1;
  }

  return messages;
}

/**
 * Creates a provider whose `chat()` returns a short summary (used by
 * SummarisationStrategy) and whose `stream()` yields a single text
 * response then stops (so the loop terminates after one iteration).
 */
function createCompactionProvider(summaryText: string): Provider {
  return {
    config: {
      id: "anthropic",
      name: "Anthropic",
      type: "oauth",
    },
    async chat(_request: ChatRequest): Promise<ChatResponse> {
      return {
        content: summaryText,
        model: "test-model",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        finishReason: "stop",
      };
    },
    async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
      yield { type: "token", content: "Acknowledged." };
      yield {
        type: "done",
        finishReason: "stop",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
      };
    },
    async listModels(): Promise<Model[]> {
      return [createModel("test-model")];
    },
    async validateConnection(): Promise<boolean> {
      return true;
    },
  };
}

describe("AgentLoop auto-compaction", () => {
  it("emits compaction event when context utilisation exceeds threshold", async () => {
    const maxTokens = 1000;
    const messages = buildHighUtilisationMessages(maxTokens, 0.95);
    const provider = createCompactionProvider("Conversation summary for compaction.");

    const eventBus = createHarnessEventBus();
    const compactionEvents: EventEnvelope<"compaction", CompactionEventPayload>[] = [];
    eventBus.on("compaction", (event) => {
      compactionEvents.push(event);
    });

    const contextManager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: maxTokens,
    });

    const beforeReport = contextManager.getUsageReport(messages, maxTokens);
    expect(beforeReport.utilization).toBeGreaterThanOrEqual(0.9);

    const beforeMessageCount = messages.length;
    const loop = new AgentLoop({ eventBus });
    const executor = createExecutor("notes.create");

    const events: LoopEvent[] = [];
    for await (const event of loop.runWithProvider({
      provider,
      model: "test-model",
      messages,
      toolExecutor: executor,
      toolContext,
      contextManager,
      contextLimitTokens: maxTokens,
      autoCompaction: {
        enabled: true,
        threshold: 0.9,
        keepRecentMessages: 4,
        summaryMaxTokens: 200,
      },
    })) {
      events.push(event);
    }

    const compactionLoopEvents = events.filter((e) => e.type === "compaction");
    expect(compactionLoopEvents).toHaveLength(1);

    const compactionEvent = compactionLoopEvents[0];
    expect(compactionEvent?.type).toBe("compaction");
    if (compactionEvent?.type === "compaction") {
      expect(compactionEvent.beforeTokenEstimate).toBeGreaterThan(0);
      expect(compactionEvent.afterTokenEstimate).toBeGreaterThan(0);
      expect(compactionEvent.afterTokenEstimate).toBeLessThan(compactionEvent.beforeTokenEstimate);
      expect(typeof compactionEvent.summary).toBe("string");
    }

    expect(compactionEvents).toHaveLength(1);
    expect(compactionEvents[0]?.payload.beforeTokenEstimate).toBeGreaterThan(0);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });

  it("skips compaction when autoCompaction is disabled", async () => {
    const maxTokens = 1000;
    const messages = buildHighUtilisationMessages(maxTokens, 0.95);
    const provider = createCompactionProvider("Should not be called.");

    const eventBus = createHarnessEventBus();
    const compactionEvents: EventEnvelope<"compaction", CompactionEventPayload>[] = [];
    eventBus.on("compaction", (event) => {
      compactionEvents.push(event);
    });

    const contextManager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: maxTokens,
    });

    const loop = new AgentLoop({ eventBus });
    const executor = createExecutor("notes.create");

    const events: LoopEvent[] = [];
    for await (const event of loop.runWithProvider({
      provider,
      model: "test-model",
      messages,
      toolExecutor: executor,
      toolContext,
      contextManager,
      contextLimitTokens: maxTokens,
      autoCompaction: {
        enabled: false,
      },
    })) {
      events.push(event);
    }

    const compactionLoopEvents = events.filter((e) => e.type === "compaction");
    expect(compactionLoopEvents).toHaveLength(0);
    expect(compactionEvents).toHaveLength(0);

    const doneEvent = events.find((e) => e.type === "done");
    expect(doneEvent).toBeDefined();
  });

  it("reduces context to at most 40% utilisation after compaction", async () => {
    const maxTokens = 1000;
    const messages = buildHighUtilisationMessages(maxTokens, 0.95);
    const provider = createCompactionProvider("Brief summary.");

    const contextManager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: maxTokens,
    });

    const beforeReport = contextManager.getUsageReport(messages, maxTokens);
    expect(beforeReport.utilization).toBeGreaterThanOrEqual(0.9);

    const loop = new AgentLoop();
    const executor = createExecutor("notes.create");

    const events: LoopEvent[] = [];
    for await (const event of loop.runWithProvider({
      provider,
      model: "test-model",
      messages,
      toolExecutor: executor,
      toolContext,
      contextManager,
      contextLimitTokens: maxTokens,
      autoCompaction: {
        enabled: true,
        threshold: 0.9,
        keepRecentMessages: 4,
        summaryMaxTokens: 100,
      },
    })) {
      events.push(event);
    }

    const compactionEvent = events.find((e) => e.type === "compaction");
    expect(compactionEvent).toBeDefined();

    if (compactionEvent?.type === "compaction") {
      const postCompactionUtilisation = compactionEvent.afterTokenEstimate / maxTokens;
      expect(postCompactionUtilisation).toBeLessThanOrEqual(0.4);
    }
  });
});
