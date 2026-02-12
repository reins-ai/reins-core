import { describe, expect, it } from "bun:test";

import { ConversationManager, InMemoryConversationStore } from "../../src/conversation";
import { MockProvider } from "../../src/providers";
import { StreamingResponse } from "../../src/streaming";
import type { ChatRequest, Model, StreamEvent, ToolCall } from "../../src/types";

type Platform = "tui" | "desktop" | "mobile";

interface NormalizedEvent {
  type: StreamEvent["type"];
  token?: string;
  toolName?: string;
  toolCallId?: string;
  resultName?: string;
  finishReason?: string;
  totalTokens?: number;
  error?: string;
}

const platforms: Platform[] = ["tui", "desktop", "mobile"];

const model: Model = {
  id: "parity-model",
  name: "Parity Model",
  provider: "mock-provider",
  contextWindow: 8192,
  capabilities: ["chat", "streaming", "tool_use"],
};

const toolCall: ToolCall = {
  id: "tool-parity-1",
  name: "calendar",
  arguments: {
    action: "list_events",
    start: "2026-01-01T00:00:00.000Z",
    end: "2026-01-02T00:00:00.000Z",
  },
};

const createRequest = (messages: ChatRequest["messages"]): ChatRequest => ({
  model: model.id,
  messages,
});

async function collectNormalizedEvents(source: AsyncIterable<StreamEvent>): Promise<NormalizedEvent[]> {
  const normalized: NormalizedEvent[] = [];

  for await (const event of source) {
    if (event.type === "token") {
      normalized.push({ type: event.type, token: event.content });
      continue;
    }

    if (event.type === "tool_call_start") {
      normalized.push({
        type: event.type,
        toolName: event.toolCall.name,
        toolCallId: event.toolCall.id,
      });
      continue;
    }

    if (event.type === "tool_call_end") {
      normalized.push({
        type: event.type,
        toolCallId: event.result.callId,
        resultName: event.result.name,
      });
      continue;
    }

    if (event.type === "error") {
      normalized.push({ type: event.type, error: event.error.message });
      continue;
    }

    normalized.push({
      type: event.type,
      finishReason: event.finishReason,
      totalTokens: event.usage.totalTokens,
    });
  }

  return normalized;
}

async function runStreamingScenario(
  platform: Platform,
  options: {
    responseContent?: string;
    toolCalls?: ToolCall[];
    simulateError?: boolean;
    errorMessage?: string;
  },
): Promise<{ events: NormalizedEvent[]; finalContent: string }> {
  const store = new InMemoryConversationStore();
  const manager = new ConversationManager(store);
  const conversation = await manager.create({
    title: `Parity ${platform}`,
    model: model.id,
    provider: model.provider,
  });

  await manager.addMessage(conversation.id, {
    role: "user",
    content: "Summarize my next priorities.",
  });

  const history = await manager.getHistory(conversation.id);
  const provider = new MockProvider({
    config: { id: model.provider, name: `Mock ${platform}`, type: "local" },
    models: [model],
    responseContent: options.responseContent ?? "Your top priorities are planning, review, and execution.",
    toolCalls: options.toolCalls,
    simulateError: options.simulateError,
    errorMessage: options.errorMessage,
  });

  const events = await collectNormalizedEvents(provider.stream(createRequest(history)));
  const stream = new StreamingResponse(provider.stream(createRequest(history)));
  const collected = await stream.collect();

  return {
    events,
    finalContent: collected.content,
  };
}

describe("cross-platform/conversation-parity", () => {
  it("produces identical streaming events for the same user message", async () => {
    const baseline = await runStreamingScenario("tui", {});

    for (const platform of platforms.slice(1)) {
      const candidate = await runStreamingScenario(platform, {});
      expect(candidate.events).toEqual(baseline.events);
    }
  });

  it("emits identical tool call lifecycle events and results", async () => {
    const baseline = await runStreamingScenario("tui", {
      responseContent: "Checking the calendar now.",
      toolCalls: [toolCall],
    });

    for (const platform of platforms.slice(1)) {
      const candidate = await runStreamingScenario(platform, {
        responseContent: "Checking the calendar now.",
        toolCalls: [toolCall],
      });
      expect(candidate.events).toEqual(baseline.events);
    }
  });

  it("keeps message ordering deterministic across platform runners", async () => {
    const orderedRolesByPlatform: Record<Platform, string[]> = {
      tui: [],
      desktop: [],
      mobile: [],
    };

    for (const platform of platforms) {
      const store = new InMemoryConversationStore();
      const manager = new ConversationManager(store);
      const conversation = await manager.create({
        title: `Ordering ${platform}`,
        model: model.id,
        provider: model.provider,
        systemPrompt: "Be concise.",
      });

      await manager.addMessage(conversation.id, { role: "user", content: "First" });
      await manager.addMessage(conversation.id, { role: "assistant", content: "First reply" });
      await manager.addMessage(conversation.id, { role: "user", content: "Second" });
      await manager.addMessage(conversation.id, { role: "assistant", content: "Second reply" });

      const history = await manager.getHistory(conversation.id);
      orderedRolesByPlatform[platform] = history.map((message) => message.role);
    }

    expect(orderedRolesByPlatform.desktop).toEqual(orderedRolesByPlatform.tui);
    expect(orderedRolesByPlatform.mobile).toEqual(orderedRolesByPlatform.tui);
    expect(orderedRolesByPlatform.tui).toEqual(["system", "user", "assistant", "user", "assistant"]);
  });

  it("accumulates tokens into identical final assistant content", async () => {
    const expected = "Shared core ensures all clients render the same final answer.";
    const results = await Promise.all(
      platforms.map((platform) => runStreamingScenario(platform, { responseContent: expected })),
    );

    for (const result of results) {
      expect(result.finalContent).toBe(expected);
    }
  });

  it("reports consistent error events", async () => {
    const expectedError = "simulated parity failure";
    const baseline = await runStreamingScenario("tui", {
      simulateError: true,
      errorMessage: expectedError,
      responseContent: "",
    });

    for (const platform of platforms.slice(1)) {
      const candidate = await runStreamingScenario(platform, {
        simulateError: true,
        errorMessage: expectedError,
        responseContent: "",
      });
      expect(candidate.events).toEqual(baseline.events);
    }

    const errorEvent = baseline.events.find((event) => event.type === "error");
    expect(errorEvent?.error).toBe(expectedError);
  });
});
