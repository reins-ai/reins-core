import { describe, expect, it } from "bun:test";

import { ContextManager } from "../../src/context/manager";
import { DropOldestStrategy } from "../../src/context/strategies";
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
  it("passes through messages when under limit", () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "hello", 1)];
    const prepared = manager.prepare(input, { maxTokens: 200 });

    expect(prepared).toEqual(input);
  });

  it("truncates when over limit", () => {
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

    const prepared = manager.prepare(input, { maxTokens: 25 });

    expect(prepared.length).toBeLessThan(input.length);
    expect(prepared.some((item) => item.role === "system")).toBe(true);
  });

  it("adds system prompt when missing", () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [message("m1", "user", "hi there", 1)];
    const prepared = manager.prepare(input, {
      maxTokens: 200,
      systemPrompt: "You are Reins.",
    });

    expect(prepared[0]?.role).toBe("system");
    expect(prepared[0]?.content).toBe("You are Reins.");
  });

  it("respects reservedForOutput", () => {
    const manager = new ContextManager({
      strategy: new DropOldestStrategy(),
      defaultMaxTokens: 200,
    });

    const input = [
      message("m1", "system", "system", 1),
      message("m2", "user", "x".repeat(120), 2),
    ];

    const withoutReserve = manager.prepare(input, {
      maxTokens: 60,
      reservedForOutput: 0,
    });
    const withReserve = manager.prepare(input, {
      maxTokens: 60,
      reservedForOutput: 30,
    });

    expect(withReserve.length).toBeLessThanOrEqual(withoutReserve.length);
  });

  it("supports per-model token limit configuration", () => {
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

    const prepared = manager.prepare(input, {
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
});
