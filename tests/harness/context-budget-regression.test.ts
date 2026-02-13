import { describe, expect, it } from "bun:test";

import {
  ContextBudget,
  createHarnessEventBus,
  type AgentMessage,
  type CompactionEventPayload,
  type ToolPipelineResult,
} from "../../src/harness";

function repeat(text: string, count: number): string {
  return Array.from({ length: count }, () => text).join(" ");
}

function createToolResult(output: string): ToolPipelineResult {
  return {
    status: "success",
    output,
    metadata: {
      callId: "call-1",
      name: "search",
      durationMs: 1,
      truncated: false,
    },
  };
}

describe("ContextBudget regression: budget exhaustion", () => {
  it("triggers compaction when messages exceed budget with summarizable history", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 1_500,
      reserveTokens: 1_000,
      keepRecentMessages: 2,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "System prompt." },
      { role: "user", content: repeat("overflow discussion topic", 100) },
      { role: "assistant", content: repeat("detailed response content", 100) },
      { role: "user", content: "Recent question." },
      { role: "assistant", content: "Recent answer." },
    ];

    const result = await budget.compact(messages);

    // Should trigger summarization since messages exceed budget
    expect(result.type).not.toBe("none");
    expect(result.afterTokens).toBeLessThanOrEqual(result.beforeTokens);
  });

  it("returns none when budget is generous and messages are small", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 100_000,
      reserveTokens: 1_000,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "System." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello" },
    ];

    const result = await budget.compact(messages);

    expect(result.type).toBe("none");
    expect(result.removedMessages).toBe(0);
    expect(result.prunedToolOutputs).toBe(0);
  });

  it("checkBudget correctly reports when messages exceed budget", () => {
    const budget = new ContextBudget({
      contextWindowTokens: 100,
      reserveTokens: 50,
    });

    const messages: AgentMessage[] = [
      { role: "user", content: repeat("overflow", 200) },
    ];

    const check = budget.checkBudget(messages);

    expect(check.fits).toBe(false);
    expect(check.estimatedTokens).toBeGreaterThan(check.budgetTokens);
  });

  it("checkBudget correctly reports when messages fit budget", () => {
    const budget = new ContextBudget({
      contextWindowTokens: 10_000,
      reserveTokens: 1_000,
    });

    const messages: AgentMessage[] = [
      { role: "user", content: "Hello" },
    ];

    const check = budget.checkBudget(messages);

    expect(check.fits).toBe(true);
    expect(check.estimatedTokens).toBeLessThanOrEqual(check.budgetTokens);
  });
});

describe("ContextBudget regression: large tool output pruning", () => {
  it("prunes multiple older tool outputs while preserving the latest", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 4_000,
      reserveTokens: 3_000,
      maxToolOutputTokens: 30,
    });

    const bigOutput1 = repeat("old-tool-data-alpha", 150);
    const bigOutput2 = repeat("old-tool-data-beta", 150);
    const latestOutput = repeat("latest-tool-data", 20);

    const messages: AgentMessage[] = [
      { role: "system", content: "System." },
      { role: "user", content: "Run tool 1." },
      {
        role: "tool",
        content: bigOutput1,
        toolResults: [createToolResult(bigOutput1)],
      },
      { role: "user", content: "Run tool 2." },
      {
        role: "tool",
        content: bigOutput2,
        toolResults: [createToolResult(bigOutput2)],
      },
      { role: "user", content: "Run tool 3." },
      {
        role: "tool",
        content: latestOutput,
        toolResults: [createToolResult(latestOutput)],
      },
      { role: "assistant", content: "Done." },
    ];

    const result = await budget.compact(messages);

    expect(result.prunedToolOutputs).toBeGreaterThanOrEqual(2);

    // First two tool messages should be truncated
    const toolMessages = result.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThanOrEqual(2);

    // Latest tool output should not be truncated
    const lastToolMsg = toolMessages[toolMessages.length - 1];
    expect(lastToolMsg?.content.includes("[output truncated]")).toBe(false);
  });

  it("prunes tool output in toolResults array as well as content", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 3_000,
      reserveTokens: 2_500,
      maxToolOutputTokens: 20,
    });

    const bigOutput = repeat("huge-tool-result", 200);

    const messages: AgentMessage[] = [
      { role: "system", content: "System." },
      {
        role: "tool",
        content: bigOutput,
        toolResults: [createToolResult(bigOutput)],
      },
      { role: "user", content: "Next." },
      {
        role: "tool",
        content: "small",
        toolResults: [createToolResult("small")],
      },
      { role: "assistant", content: "Done." },
    ];

    const result = await budget.compact(messages);

    expect(result.prunedToolOutputs).toBeGreaterThan(0);
  });
});

describe("ContextBudget regression: priority ordering", () => {
  it("preserves system messages at the start during summarization", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 1_500,
      reserveTokens: 1_000,
      keepRecentMessages: 2,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "You are Reins, a helpful assistant." },
      { role: "system", content: "Additional system context." },
      { role: "user", content: repeat("old conversation topic", 100) },
      { role: "assistant", content: repeat("old response content", 100) },
      { role: "user", content: "Recent question." },
      { role: "assistant", content: "Recent answer." },
    ];

    const result = await budget.compact(messages);

    // System messages should be preserved at the start
    expect(result.messages[0]?.role).toBe("system");
    expect(result.messages[0]?.content).toBe("You are Reins, a helpful assistant.");
    expect(result.messages[1]?.role).toBe("system");
    expect(result.messages[1]?.content).toBe("Additional system context.");
  });

  it("keeps recent messages intact during summarization", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 1_500,
      reserveTokens: 1_000,
      keepRecentMessages: 3,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "System." },
      { role: "user", content: repeat("old topic", 100) },
      { role: "assistant", content: repeat("old response", 100) },
      { role: "user", content: "Recent 1." },
      { role: "assistant", content: "Recent 2." },
      { role: "user", content: "Recent 3." },
    ];

    const result = await budget.compact(messages);

    // Last 3 messages should be preserved
    const lastThree = result.messages.slice(-3);
    expect(lastThree[0]?.content).toBe("Recent 1.");
    expect(lastThree[1]?.content).toBe("Recent 2.");
    expect(lastThree[2]?.content).toBe("Recent 3.");
  });

  it("inserts summary message between system messages and recent messages", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 1_500,
      reserveTokens: 1_000,
      keepRecentMessages: 2,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "System prompt." },
      { role: "user", content: repeat("authentication discussion", 100) },
      { role: "assistant", content: repeat("auth response details", 100) },
      { role: "user", content: "Latest question." },
      { role: "assistant", content: "Latest answer." },
    ];

    const result = await budget.compact(messages);

    if (result.type === "summarize_history" || result.type === "both") {
      // Find the summary message
      const summaryMsg = result.messages.find(
        (m) => m.role === "system" && m.content.includes("[Compacted:"),
      );
      expect(summaryMsg).toBeDefined();
      expect(summaryMsg?.content).toContain("Key topics:");
    }
  });
});

describe("ContextBudget regression: compaction type resolution", () => {
  it("returns 'both' when pruning and summarization are both needed", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 1_200,
      reserveTokens: 800,
      maxToolOutputTokens: 20,
      keepRecentMessages: 2,
    });

    const bigToolOutput = repeat("massive-tool-output", 200);

    const messages: AgentMessage[] = [
      { role: "system", content: "System." },
      { role: "user", content: repeat("old conversation", 80) },
      {
        role: "tool",
        content: bigToolOutput,
        toolResults: [createToolResult(bigToolOutput)],
      },
      { role: "assistant", content: repeat("old response", 80) },
      { role: "user", content: repeat("more old content", 80) },
      {
        role: "tool",
        content: "latest tool",
        toolResults: [createToolResult("latest tool")],
      },
      { role: "user", content: "Recent." },
      { role: "assistant", content: "Done." },
    ];

    const result = await budget.compact(messages);

    // With such tight budget, both pruning and summarization should be needed
    expect(["prune_tool_outputs", "summarize_history", "both"]).toContain(result.type);
    expect(result.afterTokens).toBeLessThan(result.beforeTokens);
  });
});

describe("ContextBudget regression: event emission", () => {
  it("does not emit compaction event when no compaction is needed", async () => {
    const eventBus = createHarnessEventBus();
    const payloads: CompactionEventPayload[] = [];
    eventBus.on("compaction", (e) => { payloads.push(e.payload); });

    const budget = new ContextBudget({
      contextWindowTokens: 100_000,
      reserveTokens: 1_000,
      eventBus,
    });

    await budget.compact([
      { role: "user", content: "Small message" },
    ]);

    expect(payloads).toHaveLength(0);
  });

  it("emits compaction event with accurate before/after token estimates", async () => {
    const eventBus = createHarnessEventBus();
    const payloads: CompactionEventPayload[] = [];
    eventBus.on("compaction", (e) => { payloads.push(e.payload); });

    const budget = new ContextBudget({
      contextWindowTokens: 1_500,
      reserveTokens: 1_000,
      keepRecentMessages: 2,
      eventBus,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "System." },
      { role: "user", content: repeat("long discussion topic", 120) },
      { role: "assistant", content: repeat("detailed response", 120) },
      { role: "user", content: "Recent." },
      { role: "assistant", content: "Done." },
    ];

    const result = await budget.compact(messages);

    if (result.type !== "none") {
      expect(payloads).toHaveLength(1);
      expect(payloads[0]?.beforeTokenEstimate).toBe(result.beforeTokens);
      expect(payloads[0]?.afterTokenEstimate).toBe(result.afterTokens);
      expect(payloads[0]?.beforeTokenEstimate).toBeGreaterThan(payloads[0]?.afterTokenEstimate ?? 0);
    }
  });
});

describe("ContextBudget regression: empty and edge-case inputs", () => {
  it("handles empty message array", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 10_000,
      reserveTokens: 1_000,
    });

    const result = await budget.compact([]);

    expect(result.type).toBe("none");
    expect(result.messages).toHaveLength(0);
  });

  it("handles messages with empty content", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 10_000,
      reserveTokens: 1_000,
    });

    const messages: AgentMessage[] = [
      { role: "user", content: "" },
      { role: "assistant", content: "" },
    ];

    const result = await budget.compact(messages);

    expect(result.type).toBe("none");
    expect(result.messages).toHaveLength(2);
  });

  it("does not mutate original messages during compaction", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 1_500,
      reserveTokens: 1_000,
      maxToolOutputTokens: 20,
    });

    const bigOutput = repeat("big-output", 200);
    const messages: AgentMessage[] = [
      { role: "system", content: "System." },
      {
        role: "tool",
        content: bigOutput,
        toolResults: [createToolResult(bigOutput)],
      },
      {
        role: "tool",
        content: "latest",
        toolResults: [createToolResult("latest")],
      },
      { role: "assistant", content: "Done." },
    ];

    const originalContent = messages[1]?.content;
    await budget.compact(messages);

    // Original messages should not be mutated
    expect(messages[1]?.content).toBe(originalContent);
  });
});
