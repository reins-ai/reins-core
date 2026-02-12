import { describe, expect, it } from "bun:test";

import { ConversationManager } from "../../src/conversation/manager";
import { InMemoryConversationStore } from "../../src/conversation/memory-store";
import type { Conversation, Message } from "../../src/types";
import { benchmark, benchmarkAsync, formatBenchmark } from "../../src/utils";

async function createConversationWithMessages(messageCount: number): Promise<{
  manager: ConversationManager;
  conversation: Conversation;
}> {
  const now = Date.now();
  const messages: Message[] = Array.from({ length: messageCount }, (_, index) => ({
    id: `msg-${index}`,
    role: index % 2 === 0 ? "user" : "assistant",
    content: `message ${index}`,
    createdAt: new Date(now + index),
  }));

  const conversation: Conversation = {
    id: `conv-${messageCount}`,
    title: `Perf conversation ${messageCount}`,
    messages,
    model: "mock-model",
    provider: "mock-provider",
    createdAt: new Date(now),
    updatedAt: new Date(now + messageCount),
  };

  const store = new InMemoryConversationStore();
  await store.save(conversation);

  return {
    manager: new ConversationManager(store),
    conversation,
  };
}

function searchMessages(messages: Message[], query: string): number {
  let matches = 0;
  for (const message of messages) {
    if (message.content.includes(query)) {
      matches += 1;
    }
  }

  return matches;
}

describe("performance: conversation", () => {
  it("measures history load with 100, 500, and 1000 messages", async () => {
    const sizes = [100, 500, 1000];

    for (const size of sizes) {
      const { manager, conversation } = await createConversationWithMessages(size);

      const result = await benchmarkAsync(
        `conversation history load (${size} messages)`,
        async () => {
          const history = await manager.getHistory(conversation.id);
          expect(history).toHaveLength(size);
        },
        10,
      );

      console.info(formatBenchmark(result));
      expect(result.averageMs).toBeLessThan(50);
    }
  });

  it("measures message search across large conversations", async () => {
    const { manager, conversation } = await createConversationWithMessages(1000);
    const history = await manager.getHistory(conversation.id);

    const result = benchmark(
      "conversation message search (1000 messages)",
      () => {
        const matches = searchMessages(history, "message 9");
        expect(matches).toBeGreaterThan(0);
      },
      200,
    );

    console.info(formatBenchmark(result));
    expect(result.averageMs).toBeLessThan(5);
  });

  it("measures conversation serialization and deserialization", async () => {
    const { conversation } = await createConversationWithMessages(1000);

    const result = benchmark(
      "conversation serialization/deserialization (1000 messages)",
      () => {
        const serialized = JSON.stringify(conversation);
        const parsed = JSON.parse(serialized) as Conversation;
        expect(parsed.messages).toHaveLength(1000);
      },
      30,
    );

    console.info(formatBenchmark(result));
    expect(result.averageMs).toBeLessThan(100);
  });
});
