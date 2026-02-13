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

describe("ContextBudget", () => {
  it("reports budget fit when estimated tokens are under the limit", () => {
    const budget = new ContextBudget({
      contextWindowTokens: 12_000,
      reserveTokens: 1_000,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "You are Reins." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi!" },
    ];

    const result = budget.checkBudget(messages);

    expect(result.fits).toBe(true);
    expect(result.budgetTokens).toBe(11_000);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("prunes older tool outputs but preserves the latest tool output round", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 3_800,
      reserveTokens: 3_000,
      maxToolOutputTokens: 50,
    });

    const oldOutput = repeat("legacy-tool-output", 200);
    const latestOutput = repeat("latest-tool-output", 30);

    const messages: AgentMessage[] = [
      { role: "system", content: "System instructions." },
      { role: "user", content: "Run the first tool." },
      { role: "assistant", content: "Calling tool now." },
      {
        role: "tool",
        content: oldOutput,
        toolResults: [createToolResult(oldOutput)],
      },
      { role: "user", content: "Run another tool." },
      {
        role: "tool",
        content: latestOutput,
        toolResults: [createToolResult(latestOutput)],
      },
      { role: "assistant", content: "Done." },
    ];

    const result = await budget.compact(messages);

    expect(result.type).toBe("prune_tool_outputs");
    expect(result.prunedToolOutputs).toBeGreaterThan(0);
    expect(result.removedMessages).toBe(0);

    const prunedToolMessage = result.messages[3];
    expect(prunedToolMessage?.content.includes("[output truncated]")).toBe(true);

    const latestToolMessage = result.messages[5];
    expect(latestToolMessage?.content.includes("[output truncated]")).toBe(false);
  });

  it("summarizes older history when pruning is insufficient", async () => {
    const budget = new ContextBudget({
      contextWindowTokens: 2_000,
      reserveTokens: 1_500,
      keepRecentMessages: 3,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "System prompt." },
      { role: "user", content: repeat("authentication telemetry rollout", 120) },
      { role: "assistant", content: repeat("capturing baseline metrics", 120) },
      { role: "user", content: repeat("dashboard incidents triage", 120) },
      { role: "assistant", content: repeat("mitigation and checkpoint notes", 120) },
      { role: "user", content: "Keep this latest context available." },
      { role: "assistant", content: "Acknowledged." },
    ];

    const result = await budget.compact(messages);

    expect(result.type).toBe("summarize_history");
    expect(result.removedMessages).toBeGreaterThan(0);
    expect(result.summary).toContain("[Compacted:");
    expect(result.messages.some((message) => message.role === "system" && message.content.includes("Key topics:"))).toBe(
      true,
    );
  });

  it("emits compaction events with token estimates", async () => {
    const eventBus = createHarnessEventBus();
    const payloads: CompactionEventPayload[] = [];

    eventBus.on("compaction", (event) => {
      payloads.push(event.payload);
    });

    const budget = new ContextBudget({
      contextWindowTokens: 1_800,
      reserveTokens: 1_300,
      keepRecentMessages: 2,
      eventBus,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "System prompt." },
      { role: "user", content: repeat("performance regression trace", 140) },
      { role: "assistant", content: repeat("error budget analysis", 140) },
      { role: "user", content: repeat("staging rollout decision", 140) },
      { role: "assistant", content: "Recent response." },
    ];

    const result = await budget.compact(messages);

    expect(result.type).toBe("summarize_history");
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.summary).toContain("Compacted");
    expect(payloads[0]?.beforeTokenEstimate).toBe(result.beforeTokens);
    expect(payloads[0]?.afterTokenEstimate).toBe(result.afterTokens);
  });

  it("returns no-op compaction when context fits budget", async () => {
    const eventBus = createHarnessEventBus();
    const payloads: CompactionEventPayload[] = [];

    eventBus.on("compaction", (event) => {
      payloads.push(event.payload);
    });

    const budget = new ContextBudget({
      contextWindowTokens: 20_000,
      reserveTokens: 1_000,
      eventBus,
    });

    const messages: AgentMessage[] = [
      { role: "system", content: "System prompt." },
      { role: "user", content: "small input" },
      { role: "assistant", content: "small response" },
    ];

    const result = await budget.compact(messages);

    expect(result.type).toBe("none");
    expect(result.prunedToolOutputs).toBe(0);
    expect(result.removedMessages).toBe(0);
    expect(result.messages).toHaveLength(messages.length);
    expect(payloads).toHaveLength(0);
  });
});
