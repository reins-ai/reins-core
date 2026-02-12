import { describe, expect, it } from "bun:test";

import { ConversationManager, InMemoryConversationStore } from "../../src/conversation";
import { ToolExecutor, ToolRegistry } from "../../src/tools";
import { MockProvider } from "../../src/providers";
import type { Tool, ToolCall, ToolContext, ToolResult } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "pending",
  userId: "user-1",
  workspaceId: "ws-1",
};

const getWeatherCall: ToolCall = {
  id: "call-weather-1",
  name: "get_weather",
  arguments: { location: "San Francisco" },
};

const getWeatherTool: Tool = {
  definition: {
    name: "get_weather",
    description: "Get weather forecast for a location",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string" },
      },
      required: ["location"],
    },
  },
  async execute(args: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
    const location = typeof args.location === "string" ? args.location : "unknown";
    return {
      callId: "ignored",
      name: "internal",
      result: {
        location,
        forecast: "Sunny",
        temperatureF: 72,
      },
    };
  },
};

describe("integration/tool-execution", () => {
  it("executes provider-requested tool calls within a conversation", async () => {
    const firstProvider = new MockProvider({
      responseContent: "I'll check the weather now.",
      toolCalls: [getWeatherCall],
      finishReason: "tool_use",
    });
    const secondProvider = new MockProvider({
      responseContent: "It's sunny and 72F in San Francisco.",
      finishReason: "stop",
    });

    const toolRegistry = new ToolRegistry();
    toolRegistry.register(getWeatherTool);
    const executor = new ToolExecutor(toolRegistry);

    const manager = new ConversationManager(new InMemoryConversationStore());
    const conversation = await manager.create({
      title: "Weather",
      model: "mock-model-1",
      provider: "mock-provider",
    });

    await manager.addMessage(conversation.id, {
      role: "user",
      content: "What's the weather?",
    });

    const firstTurnMessages = await manager.getHistory(conversation.id);
    const firstResponse = await firstProvider.chat({
      model: "mock-model-1",
      messages: firstTurnMessages,
      tools: toolRegistry.getDefinitions(),
    });

    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: firstResponse.content,
      toolCalls: firstResponse.toolCalls,
    });

    const executionContext: ToolContext = {
      ...toolContext,
      conversationId: conversation.id,
    };
    const toolResult = await executor.execute(getWeatherCall, executionContext);

    await manager.addMessage(conversation.id, {
      role: "tool",
      content: JSON.stringify(toolResult.result),
      toolResultId: toolResult.callId,
    });

    const secondTurnMessages = await manager.getHistory(conversation.id);
    const secondResponse = await secondProvider.chat({
      model: "mock-model-1",
      messages: secondTurnMessages,
    });

    await manager.addMessage(conversation.id, {
      role: "assistant",
      content: secondResponse.content,
    });

    const finalHistory = await manager.getHistory(conversation.id);
    expect(finalHistory.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(finalHistory[1]?.toolCalls?.[0]?.name).toBe("get_weather");
    expect(finalHistory[2]?.toolResultId).toBe(getWeatherCall.id);
    expect(finalHistory[3]?.content).toContain("72F");
  });

  it("runs tool calls in parallel and captures missing-tool failures", async () => {
    const toolRegistry = new ToolRegistry();
    toolRegistry.register(getWeatherTool);
    const executor = new ToolExecutor(toolRegistry);

    const results = await executor.executeMany(
      [
        {
          id: "call-1",
          name: "get_weather",
          arguments: { location: "San Francisco" },
        },
        {
          id: "call-2",
          name: "missing_tool",
          arguments: {},
        },
      ],
      {
        ...toolContext,
        conversationId: "conv-1",
      },
    );

    expect(results).toHaveLength(2);
    expect(results[0]?.error).toBeUndefined();
    expect(results[0]?.result).toEqual({
      location: "San Francisco",
      forecast: "Sunny",
      temperatureF: 72,
    });
    expect(results[1]?.result).toBeNull();
    expect(results[1]?.error).toBe("Tool not found: missing_tool");
  });
});
