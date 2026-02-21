import { describe, expect, it } from "bun:test";

import {
  DropOldestStrategy,
  KeepSystemAndRecentStrategy,
  SlidingWindowStrategy,
} from "../../src/context/strategies";
import { estimateConversationTokens } from "../../src/context/tokenizer";
import type { Message } from "../../src/types";

const makeMessage = (
  id: string,
  role: Message["role"],
  content: string,
  createdAtSeed: number,
): Message => ({
  id,
  role,
  content,
  createdAt: new Date(createdAtSeed),
});

describe("truncation strategies", () => {
  it("DropOldestStrategy preserves system messages", () => {
    const strategy = new DropOldestStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "You are Reins", 1),
      makeMessage("m2", "user", "old user", 2),
      makeMessage("m3", "assistant", "old assistant", 3),
      makeMessage("m4", "user", "recent user", 4),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 30,
      reservedTokens: 0,
    });

    expect(truncated.some((message) => message.role === "system")).toBe(true);
  });

  it("DropOldestStrategy drops oldest non-system messages first", () => {
    const strategy = new DropOldestStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "system setup", 1),
      makeMessage("m2", "user", "first", 2),
      makeMessage("m3", "assistant", "second", 3),
      makeMessage("m4", "user", "third", 4),
      makeMessage("m5", "assistant", "fourth", 5),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 25,
      reservedTokens: 0,
    });

    expect(truncated.find((message) => message.id === "m2")).toBeUndefined();
    expect(truncated.find((message) => message.id === "m5")).toBeDefined();
  });

  it("SlidingWindowStrategy keeps the most recent messages", () => {
    const strategy = new SlidingWindowStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "system instructions", 1),
      makeMessage("m2", "user", "old user message", 2),
      makeMessage("m3", "assistant", "old assistant reply", 3),
      makeMessage("m4", "user", "newer user message", 4),
      makeMessage("m5", "assistant", "newest assistant reply", 5),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 28,
      reservedTokens: 0,
    });

    expect(truncated.find((message) => message.id === "m2")).toBeUndefined();
    expect(truncated.find((message) => message.id === "m5")).toBeDefined();
  });

  it("KeepSystemAndRecentStrategy keeps system messages and recent pairs", () => {
    const strategy = new KeepSystemAndRecentStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "system instructions", 1),
      makeMessage("m2", "user", "old question", 2),
      makeMessage("m3", "assistant", "old answer", 3),
      makeMessage("m4", "user", "new question", 4),
      makeMessage("m5", "assistant", "new answer", 5),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 30,
      reservedTokens: 0,
    });

    expect(truncated.some((message) => message.role === "system")).toBe(true);
    expect(truncated.find((message) => message.id === "m4")).toBeDefined();
    expect(truncated.find((message) => message.id === "m5")).toBeDefined();
  });

  it("handles a single oversized message across all strategies", () => {
    const oversized = makeMessage("m1", "user", "x".repeat(500), 1);
    const maxTokens = 20;

    const strategies = [
      new DropOldestStrategy(),
      new SlidingWindowStrategy(),
      new KeepSystemAndRecentStrategy(),
    ];

    for (const strategy of strategies) {
      const truncated = strategy.truncate([oversized], {
        maxTokens,
        reservedTokens: 0,
      });

      expect(estimateConversationTokens(truncated)).toBeLessThanOrEqual(maxTokens);
    }
  });

  it("DropOldestStrategy preserves summary messages when truncating", () => {
    const strategy = new DropOldestStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "system instructions", 1),
      makeMessage("m2", "user", "old user", 2),
      {
        ...makeMessage("m3", "assistant", "summary of prior context", 3),
        isSummary: true,
      },
      makeMessage("m4", "assistant", "recent assistant", 4),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 28,
      reservedTokens: 0,
    });

    expect(truncated.find((message) => message.id === "m3")).toBeDefined();
  });

  it("SlidingWindowStrategy preserves summary messages when truncating", () => {
    const strategy = new SlidingWindowStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "system instructions", 1),
      makeMessage("m2", "user", "old user", 2),
      {
        ...makeMessage("m3", "assistant", "summary of prior context", 3),
        isSummary: true,
      },
      makeMessage("m4", "user", "new user", 4),
      makeMessage("m5", "assistant", "new assistant", 5),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 30,
      reservedTokens: 0,
    });

    expect(truncated.find((message) => message.id === "m3")).toBeDefined();
  });

  it("KeepSystemAndRecentStrategy preserves summary messages when truncating", () => {
    const strategy = new KeepSystemAndRecentStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "system instructions", 1),
      makeMessage("m2", "user", "old user", 2),
      {
        ...makeMessage("m3", "assistant", "summary of prior context", 3),
        isSummary: true,
      },
      makeMessage("m4", "assistant", "old assistant", 4),
      makeMessage("m5", "user", "new user", 5),
      makeMessage("m6", "assistant", "new assistant", 6),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 34,
      reservedTokens: 0,
    });

    expect(truncated.find((message) => message.id === "m3")).toBeDefined();
  });
});
