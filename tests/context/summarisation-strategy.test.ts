import { describe, expect, it } from "bun:test";

import { DropOldestStrategy, SummarisationStrategy } from "../../src/context/strategies";
import type { ChatRequest, ChatResponse, Message, Provider } from "../../src/types";

function makeMessage(
  id: string,
  role: Message["role"],
  content: string,
  createdAtSeed: number,
  isSummary = false,
): Message {
  return {
    id,
    role,
    content,
    createdAt: new Date(createdAtSeed),
    isSummary,
  };
}

function makeProvider(chatImpl: (request: ChatRequest) => Promise<ChatResponse>): Provider {
  return {
    config: {
      id: "test-provider",
      name: "Test Provider",
      type: "local",
    },
    chat: chatImpl,
    stream: async function* () {
      return;
    },
    listModels: async () => [
      {
        id: "test-model",
        name: "Test Model",
        provider: "test-provider",
        contextWindow: 128_000,
        capabilities: ["chat"],
      },
    ],
    validateConnection: async () => true,
  };
}

function makeLongConversation(messageCount: number): Message[] {
  const messages: Message[] = [makeMessage("system", "system", "System instructions", 1)];

  for (let index = 0; index < messageCount; index += 1) {
    const role = index % 2 === 0 ? "user" : "assistant";
    messages.push(
      makeMessage(`m-${index}`, role, `Message ${index}: ${"x".repeat(40)}`, index + 2),
    );
  }

  return messages;
}

describe("SummarisationStrategy", () => {
  it("compacts a long conversation to summary plus recent messages", async () => {
    let chatCallCount = 0;
    const provider = makeProvider(async () => {
      chatCallCount += 1;
      return {
        id: "resp-1",
        model: "test-model",
        content: "Conversation summary",
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          totalTokens: 120,
        },
        finishReason: "stop",
      };
    });
    const strategy = new SummarisationStrategy({
      provider,
      model: "test-model",
    });

    const messages = makeLongConversation(50);
    const result = await strategy.truncate(messages, {
      maxTokens: 4096,
      reservedTokens: 0,
      keepRecentMessages: 10,
    });

    expect(chatCallCount).toBe(1);
    expect(result.length).toBeLessThanOrEqual(15);
    expect(result.some((message) => message.isSummary === true)).toBe(true);
  });

  it("creates synthetic summary messages with isSummary true", async () => {
    const provider = makeProvider(async () => ({
      id: "resp-2",
      model: "test-model",
      content: "Synthetic summary content",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
      finishReason: "stop",
    }));
    const strategy = new SummarisationStrategy({
      provider,
      model: "test-model",
    });

    const result = await strategy.truncate(makeLongConversation(30), {
      maxTokens: 4096,
      reservedTokens: 0,
      keepRecentMessages: 5,
    });

    const summary = result.find((message) => message.isSummary === true);
    expect(summary).toBeDefined();
    expect(summary?.role).toBe("system");
    expect(summary?.content).toBe("Synthetic summary content");
  });

  it("falls back to DropOldestStrategy when provider.chat throws", async () => {
    const provider = makeProvider(async () => {
      throw new Error("provider unavailable");
    });
    const strategy = new SummarisationStrategy({
      provider,
      model: "test-model",
    });
    const fallback = new DropOldestStrategy();
    const input = makeLongConversation(20);
    const options = {
      maxTokens: 45,
      reservedTokens: 0,
      keepRecentMessages: 5,
    };
    const originalWarn = console.warn;
    let warnCalled = false;
    console.warn = () => {
      warnCalled = true;
    };

    try {
      const result = await strategy.truncate(input, options);
      const expected = fallback.truncate(input, options);

      expect(warnCalled).toBe(true);
      expect(result).toEqual(expected);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("preserves existing summary messages from input", async () => {
    const provider = makeProvider(async () => ({
      id: "resp-3",
      model: "test-model",
      content: "New summary",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
      },
      finishReason: "stop",
    }));
    const strategy = new SummarisationStrategy({
      provider,
      model: "test-model",
    });
    const messages = [
      makeMessage("sys", "system", "System instructions", 1),
      makeMessage("legacy-summary", "system", "Previous summary", 2, true),
      ...makeLongConversation(15).slice(1),
    ];

    const result = await strategy.truncate(messages, {
      maxTokens: 4096,
      reservedTokens: 0,
      keepRecentMessages: 5,
    });

    expect(result.find((message) => message.id === "legacy-summary")).toBeDefined();
  });
});
