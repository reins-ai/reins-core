import { describe, expect, it } from "bun:test";

import { ContextManager } from "../../src/context/manager";
import { ConversationError } from "../../src/errors";
import {
  DropOldestStrategy,
  KeepSystemAndRecentStrategy,
  SlidingWindowStrategy,
} from "../../src/context/strategies";
import type { Message, Model } from "../../src/types";

const mockModel: Model = {
  id: "mock-model-1",
  name: "Mock Model",
  provider: "mock-provider",
  contextWindow: 4096,
  capabilities: ["chat", "streaming", "tool_use"],
};

const longContent =
  "This is a long message used for integration testing of context management behavior. ".repeat(6);

const createMessage = (id: string, role: Message["role"], content: string, seed: number): Message => ({
  id,
  role,
  content,
  createdAt: new Date(seed),
});

const createLongConversation = (): Message[] => {
  const messages: Message[] = [createMessage("m-system", "system", "System: stay helpful.", 1)];

  for (let index = 0; index < 80; index += 1) {
    const role: Message["role"] = index % 2 === 0 ? "user" : "assistant";
    messages.push(
      createMessage(
        `m-${index}`,
        role,
        `${longContent} message=${index} `,
        index + 2,
      ),
    );
  }

  return messages;
};

describe("integration/context-management", () => {
  it("truncates oversized conversations with DropOldestStrategy", async () => {
    const input = createLongConversation();
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: mockModel.contextWindow,
    });

    const prepared = await manager.prepare(input, {
      model: mockModel,
      reservedForOutput: 512,
    });

    expect(prepared.length).toBeLessThan(input.length);
    expect(prepared[0]?.role).toBe("system");
    expect(prepared.some((message) => message.id === "m-79")).toBe(true);
    expect(manager.estimateTokens(prepared)).toBeLessThanOrEqual(mockModel.contextWindow - 512);
  });

  it("uses a different truncation shape for SlidingWindowStrategy", async () => {
    const input: Message[] = [
      createMessage("m-system", "system", "System: stay helpful.", 1),
      createMessage("m-1", "user", "old short", 2),
      createMessage("m-2", "assistant", "x".repeat(2000), 3),
      createMessage("m-3", "user", "recent question", 4),
      createMessage("m-4", "assistant", "recent answer", 5),
    ];

    const dropOldestManager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: mockModel.contextWindow,
    });
    const slidingManager = new ContextManager({
      strategy: new SlidingWindowStrategy(),
      defaultMaxTokens: mockModel.contextWindow,
    });

    const dropOldest = await dropOldestManager.prepare(input, {
      maxTokens: 120,
      reservedForOutput: 20,
    });
    const sliding = await slidingManager.prepare(input, {
      maxTokens: 120,
      reservedForOutput: 20,
    });

    expect(sliding.length).toBeLessThan(input.length);
    expect(sliding.some((message) => message.id === "m-system")).toBe(true);
    expect(sliding.some((message) => message.id === "m-4")).toBe(true);
    expect(dropOldest.some((message) => message.id === "m-1")).toBe(false);
    expect(sliding.some((message) => message.id === "m-1")).toBe(true);
  });

  it("respects output token reservation and throws on invalid effective limit", async () => {
    const input = createLongConversation();
    const manager = new ContextManager({
      strategy: new KeepSystemAndRecentStrategy(),
      defaultMaxTokens: mockModel.contextWindow,
    });

    const withoutReserve = await manager.prepare(input, {
      model: mockModel,
      reservedForOutput: 0,
    });
    const withReserve = await manager.prepare(input, {
      model: mockModel,
      reservedForOutput: 1500,
    });

    expect(manager.estimateTokens(withReserve)).toBeLessThanOrEqual(manager.estimateTokens(withoutReserve));

    await expect(
      manager.prepare(input, {
        maxTokens: 100,
        reservedForOutput: 100,
      }),
    ).rejects.toBeInstanceOf(ConversationError);
  });
});
