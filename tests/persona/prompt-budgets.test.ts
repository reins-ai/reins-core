import { describe, expect, it } from "bun:test";

import { DEFAULT_SECTION_BUDGETS } from "../../src/persona/prompt-budgets";

describe("DEFAULT_SECTION_BUDGETS", () => {
  it("defines all expected section budgets", () => {
    expect(DEFAULT_SECTION_BUDGETS.PERSONALITY.maxChars).toBe(3000);
    expect(DEFAULT_SECTION_BUDGETS.BOUNDARIES.maxChars).toBe(2000);
    expect(DEFAULT_SECTION_BUDGETS.USER.maxChars).toBe(2000);
    expect(DEFAULT_SECTION_BUDGETS.KNOWLEDGE.maxChars).toBe(500);
    expect(DEFAULT_SECTION_BUDGETS.TOOLS.maxChars).toBe(1000);
    expect(DEFAULT_SECTION_BUDGETS.ROUTINES.maxChars).toBe(1000);
    expect(DEFAULT_SECTION_BUDGETS.GOALS.maxChars).toBe(1000);
    expect(DEFAULT_SECTION_BUDGETS.HEARTBEAT.maxChars).toBe(1000);
  });

  it("sets reserved minimums for identity-critical sections", () => {
    expect(DEFAULT_SECTION_BUDGETS.PERSONALITY.reservedMinimumChars).toBe(500);
    expect(DEFAULT_SECTION_BUDGETS.BOUNDARIES.reservedMinimumChars).toBe(300);
    expect(DEFAULT_SECTION_BUDGETS.USER.reservedMinimumChars).toBe(200);
  });

  it("keeps reserved minimums within max char limits", () => {
    const entries = [
      DEFAULT_SECTION_BUDGETS.PERSONALITY,
      DEFAULT_SECTION_BUDGETS.BOUNDARIES,
      DEFAULT_SECTION_BUDGETS.USER,
    ];

    for (const budget of entries) {
      expect(budget.reservedMinimumChars).toBeDefined();
      expect(budget.reservedMinimumChars!).toBeLessThanOrEqual(budget.maxChars);
    }
  });
});
