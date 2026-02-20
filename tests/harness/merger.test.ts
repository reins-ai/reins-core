import { describe, expect, it } from "bun:test";

import { SubAgentResultMerger } from "../../src/harness/merger";
import type { SubAgentResult } from "../../src/harness/sub-agent-pool";
import type { ChatRequest, ChatResponse, Model, Provider, StreamEvent } from "../../src/types";

function successResult(id: string, output: string): SubAgentResult {
  return {
    id,
    output,
    stepsUsed: 1,
    terminationReason: "text_only_response",
  };
}

function failedResult(id: string, message = "failed"): SubAgentResult {
  return {
    id,
    error: new Error(message),
    stepsUsed: 0,
    terminationReason: "error",
  };
}

function createMockProvider(
  content: string,
  onChat?: (request: ChatRequest) => void,
): Provider {
  return {
    config: {
      id: "mock-provider",
      name: "Mock Provider",
      type: "local",
    },
    async chat(request: ChatRequest): Promise<ChatResponse> {
      onChat?.(request);
      return {
        id: "chat-1",
        model: request.model,
        content,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        },
        finishReason: "stop",
      };
    },
    async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
      yield { type: "done", finishReason: "stop" };
    },
    async listModels(): Promise<Model[]> {
      return [
        {
          id: "mock-model",
          name: "Mock Model",
          provider: "mock-provider",
          contextWindow: 200_000,
          capabilities: ["chat"],
        },
      ];
    },
    async validateConnection(): Promise<boolean> {
      return true;
    },
  };
}

describe("SubAgentResultMerger", () => {
  it("concat joins successful outputs with default separator", () => {
    const merger = new SubAgentResultMerger();
    const results = [
      successResult("1", "alpha"),
      successResult("2", "beta"),
      successResult("3", "gamma"),
    ];

    expect(merger.concat(results)).toBe("alpha\n\n---\n\nbeta\n\n---\n\ngamma");
  });

  it("concat filters out failed results", () => {
    const merger = new SubAgentResultMerger();
    const results = [
      successResult("1", "alpha"),
      failedResult("2"),
      successResult("3", "gamma"),
    ];

    expect(merger.concat(results, { separator: " | " })).toBe("alpha | gamma");
  });

  it("concat returns fallback message when all results fail", () => {
    const merger = new SubAgentResultMerger();

    expect(merger.concat([failedResult("1"), failedResult("2")])).toBe(
      "All tasks failed to produce output.",
    );
  });

  it("concat returns empty string for empty results", () => {
    const merger = new SubAgentResultMerger();

    expect(merger.concat([])).toBe("");
  });

  it("first returns first successful result output", () => {
    const merger = new SubAgentResultMerger();
    const results = [
      failedResult("1"),
      successResult("2", "winner"),
      successResult("3", "later"),
    ];

    expect(merger.first(results)).toBe("winner");
  });

  it("first returns fallback message when all results fail", () => {
    const merger = new SubAgentResultMerger();

    expect(merger.first([failedResult("1"), failedResult("2")])).toBe(
      "All tasks failed to produce output.",
    );
  });

  it("synthesize uses provider chat output", async () => {
    const merger = new SubAgentResultMerger();
    let receivedRequest: ChatRequest | null = null;
    const provider = createMockProvider("synthesized text", (request) => {
      receivedRequest = request;
    });
    const results = [successResult("1", "part one"), successResult("2", "part two")];

    const merged = await merger.synthesize(results, {
      provider,
      model: "mock-model",
    });

    expect(merged).toBe("synthesized text");
    expect(receivedRequest?.systemPrompt).toBe(
      "Synthesize the following outputs into a single coherent response:",
    );
    expect(receivedRequest?.messages[0]?.content).toBe("part one\n\n---\n\npart two");
  });

  it("merge with synthesize strategy falls back to concat when provider is missing", async () => {
    const merger = new SubAgentResultMerger();
    const results = [successResult("1", "part one"), successResult("2", "part two")];

    const merged = await merger.merge("synthesize", results, {
      separator: " | ",
    });

    expect(merged).toBe("part one | part two");
  });

  it("merge dispatcher routes to concat, first, and synthesize", async () => {
    const merger = new SubAgentResultMerger();
    const results = [successResult("1", "alpha"), successResult("2", "beta")];
    const provider = createMockProvider("merged");

    await expect(merger.merge("concat", results, { separator: " + " })).resolves.toBe("alpha + beta");
    await expect(merger.merge("first", results)).resolves.toBe("alpha");
    await expect(merger.merge("synthesize", results, { provider, model: "mock-model" })).resolves.toBe("merged");
  });
});
