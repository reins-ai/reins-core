import { describe, expect, it } from "bun:test";

import { thinkingLevelToBudget } from "../../../src/providers/byok/thinking-utils";

describe("thinkingLevelToBudget", () => {
  it("returns undefined for none", () => {
    expect(thinkingLevelToBudget("none", 16_384)).toBeUndefined();
  });

  it("maps low, medium, and high levels to default budgets", () => {
    expect(thinkingLevelToBudget("low", 16_384)).toBe(1024);
    expect(thinkingLevelToBudget("medium", 16_384)).toBe(4096);
    expect(thinkingLevelToBudget("high", 16_384)).toBe(10_240);
  });

  it("caps the budget at maxTokens minus one", () => {
    expect(thinkingLevelToBudget("high", 5000)).toBe(4999);
    expect(thinkingLevelToBudget("medium", 2000)).toBe(1999);
    expect(thinkingLevelToBudget("low", 1025)).toBe(1024);
  });
});
