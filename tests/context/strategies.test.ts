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

  it("DropOldestStrategy handles only system messages without infinite loop", () => {
    const strategy = new DropOldestStrategy();
    const messages: Message[] = [
      makeMessage("s1", "system", "x".repeat(200), 1),
      makeMessage("s2", "system", "y".repeat(200), 2),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 20,
      reservedTokens: 0,
    });

    // Should not drop system messages; falls through to content truncation
    expect(truncated.length).toBe(2);
    expect(truncated.every((m) => m.role === "system")).toBe(true);
  });

  it("SlidingWindowStrategy handles only system messages", () => {
    const strategy = new SlidingWindowStrategy();
    const messages: Message[] = [
      makeMessage("s1", "system", "x".repeat(200), 1),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 20,
      reservedTokens: 0,
    });

    // Should truncate content of the system message to fit
    expect(truncated.length).toBe(1);
    expect(truncated[0]?.role).toBe("system");
  });

  it("KeepSystemAndRecentStrategy handles only system messages", () => {
    const strategy = new KeepSystemAndRecentStrategy();
    const messages: Message[] = [
      makeMessage("s1", "system", "x".repeat(200), 1),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 20,
      reservedTokens: 0,
    });

    expect(truncated.length).toBe(1);
    expect(truncated[0]?.role).toBe("system");
  });

  it("DropOldestStrategy respects reservedTokens", () => {
    const strategy = new DropOldestStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "system", 1),
      makeMessage("m2", "user", "first user message", 2),
      makeMessage("m3", "assistant", "first reply", 3),
      makeMessage("m4", "user", "second user message", 4),
    ];

    const withoutReserve = strategy.truncate(messages, {
      maxTokens: 40,
      reservedTokens: 0,
    });
    const withReserve = strategy.truncate(messages, {
      maxTokens: 40,
      reservedTokens: 20,
    });

    expect(withReserve.length).toBeLessThanOrEqual(withoutReserve.length);
  });

  it("SlidingWindowStrategy returns messages unchanged when under limit", () => {
    const strategy = new SlidingWindowStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "sys", 1),
      makeMessage("m2", "user", "hi", 2),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 200,
      reservedTokens: 0,
    });

    expect(truncated).toBe(messages);
  });

  it("KeepSystemAndRecentStrategy returns messages unchanged when under limit", () => {
    const strategy = new KeepSystemAndRecentStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "sys", 1),
      makeMessage("m2", "user", "hi", 2),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 200,
      reservedTokens: 0,
    });

    expect(truncated).toBe(messages);
  });

  it("DropOldestStrategy skips isSummary messages when selecting drop candidates", () => {
    const strategy = new DropOldestStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "system instructions", 1),
      {
        ...makeMessage("m2", "system", "previous summary content", 2),
        isSummary: true,
      },
      makeMessage("m3", "user", "old user message", 3),
      makeMessage("m4", "assistant", "old assistant reply", 4),
      makeMessage("m5", "user", "recent user message", 5),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 30,
      reservedTokens: 0,
    });

    // Summary message should be preserved; regular messages dropped first
    expect(truncated.find((m) => m.id === "m2")).toBeDefined();
  });

  it("SlidingWindowStrategy uses model contextWindow when available", () => {
    const strategy = new SlidingWindowStrategy();
    const messages: Message[] = [
      makeMessage("m1", "system", "system", 1),
      makeMessage("m2", "user", "x".repeat(100), 2),
      makeMessage("m3", "assistant", "y".repeat(100), 3),
      makeMessage("m4", "user", "recent", 4),
    ];

    const truncated = strategy.truncate(messages, {
      maxTokens: 200,
      reservedTokens: 0,
      model: {
        id: "test",
        name: "Test",
        provider: "test",
        contextWindow: 30,
        capabilities: ["chat"],
      },
    });

    // Should use model contextWindow (30) instead of maxTokens (200)
    expect(truncated.length).toBeLessThan(messages.length);
  });
});
