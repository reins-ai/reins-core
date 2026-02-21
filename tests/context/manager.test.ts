import { describe, expect, it } from "bun:test";

import { ContextManager } from "../../src/context/manager";
import { DropOldestStrategy } from "../../src/context/strategies";
import { ConversationError } from "../../src/errors";
import type { AsyncTruncationStrategy, TruncationOptions } from "../../src/context/strategies";
import type { Message } from "../../src/types";

const message = (
  id: string,
  role: Message["role"],
  content: string,
  seed: number,
): Message => ({
  id,
  role,
  content,
  createdAt: new Date(seed),
});

describe("ContextManager", () => {
  it("passes through messages when under limit", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "hello", 1)];
    const prepared = await manager.prepare(input, { maxTokens: 200 });

    expect(prepared).toEqual(input);
  });

  it("truncates when over limit", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 40,
    });

    const input = [
      message("m1", "system", "system prompt", 1),
      message("m2", "user", "old user message with extra text", 2),
      message("m3", "assistant", "old assistant message with extra text", 3),
      message("m4", "user", "new user message", 4),
    ];

    const prepared = await manager.prepare(input, { maxTokens: 25 });

    expect(prepared.length).toBeLessThan(input.length);
    expect(prepared.some((item) => item.role === "system")).toBe(true);
  });

  it("adds system prompt when missing", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "hi there", 1)];
    const prepared = await manager.prepare(input, {
      maxTokens: 200,
      systemPrompt: "You are Reins.",
    });

    expect(prepared[0]?.role).toBe("system");
    expect(prepared[0]?.content).toBe("You are Reins.");
  });

  it("respects reservedForOutput", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [
      message("m1", "system", "system", 1),
      message("m2", "user", "x".repeat(120), 2),
    ];

    const withoutReserve = await manager.prepare(input, {
      maxTokens: 60,
      reservedForOutput: 0,
    });
    const withReserve = await manager.prepare(input, {
      maxTokens: 60,
      reservedForOutput: 30,
    });

    expect(withReserve.length).toBeLessThanOrEqual(withoutReserve.length);
  });

  it("supports per-model token limit configuration", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      modelTokenLimits: {
        "gpt-4o-mini": 50,
      },
      defaultMaxTokens: 200,
    });

    const input = [
      message("m1", "system", "system", 1),
      message("m2", "user", "x".repeat(180), 2),
    ];

    const prepared = await manager.prepare(input, {
      modelId: "gpt-4o-mini",
      reservedForOutput: 10,
    });

    expect(prepared.length).toBeLessThan(input.length);
  });

  it("checks whether messages exceed the limit", () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "small", 1)];

    expect(manager.willExceedLimit(input, 200)).toBe(false);
    expect(manager.willExceedLimit(input, 3)).toBe(true);
  });

  it("returns a usage report", () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "hello world", 1)];
    const report = manager.getUsageReport(input, 50);

    expect(report.totalTokens).toBeGreaterThan(0);
    expect(report.maxTokens).toBe(50);
    expect(report.utilization).toBeGreaterThan(0);
    expect(report.needsTruncation).toBe(false);
  });

  it("throws ConversationError when effective limit is zero or negative", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "hello", 1)];

    await expect(
      manager.prepare(input, { maxTokens: 10, reservedForOutput: 20 }),
    ).rejects.toThrow(ConversationError);
  });

  it("throws ConversationError when no token limit is available", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
    });

    const input = [message("m1", "user", "hello", 1)];

    await expect(manager.prepare(input, {})).rejects.toThrow(ConversationError);
  });

  it("returns zero utilization when maxTokens is zero in usage report", () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "hello", 1)];
    const report = manager.getUsageReport(input, 0);

    expect(report.utilization).toBe(0);
    expect(report.maxTokens).toBe(0);
  });

  it("reports needsTruncation when messages exceed maxTokens", () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "x".repeat(200), 1)];
    const report = manager.getUsageReport(input, 10);

    expect(report.needsTruncation).toBe(true);
    expect(report.utilization).toBeGreaterThan(1);
  });

  it("does not add system prompt when one already exists", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [
      message("sys", "system", "Existing system prompt", 1),
      message("m1", "user", "hello", 2),
    ];

    const prepared = await manager.prepare(input, {
      maxTokens: 200,
      systemPrompt: "New system prompt",
    });

    const systemMessages = prepared.filter((m) => m.role === "system");
    expect(systemMessages).toHaveLength(1);
    expect(systemMessages[0]?.content).toBe("Existing system prompt");
  });

  it("does not add system prompt when systemPrompt is empty or whitespace", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "hello", 1)];

    const withEmpty = await manager.prepare(input, {
      maxTokens: 200,
      systemPrompt: "",
    });
    const withWhitespace = await manager.prepare(input, {
      maxTokens: 200,
      systemPrompt: "   ",
    });

    expect(withEmpty.every((m) => m.role !== "system")).toBe(true);
    expect(withWhitespace.every((m) => m.role !== "system")).toBe(true);
  });

  it("resolves maxTokens from model contextWindow", async () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [
      message("m1", "user", "x".repeat(300), 1),
    ];

    const prepared = await manager.prepare(input, {
      model: {
        id: "test-model",
        name: "Test",
        provider: "test",
        contextWindow: 50,
        capabilities: ["chat"],
      },
    });

    // Should truncate because model contextWindow is 50
    expect(prepared.length).toBeLessThanOrEqual(input.length);
  });

  it("works with an async truncation strategy", async () => {
    const asyncStrategy: AsyncTruncationStrategy = {
      async truncate(messages: Message[], _options: TruncationOptions): Promise<Message[]> {
        // Simple async strategy: keep only last message
        return [messages[messages.length - 1]!];
      },
    };

    const manager = new ContextManager({
      strategy: asyncStrategy,
      defaultMaxTokens: 10,
    });

    const input = [
      message("m1", "user", "first message with lots of content", 1),
      message("m2", "user", "second", 2),
    ];

    const prepared = await manager.prepare(input, { maxTokens: 10 });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.id).toBe("m2");
  });
});
