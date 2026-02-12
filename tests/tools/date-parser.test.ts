import { describe, expect, it } from "bun:test";

import { parseRelativeTime } from "../../src/tools/date-parser";

describe("parseRelativeTime", () => {
  it("parses relative minute expressions", () => {
    const before = Date.now();
    const parsed = parseRelativeTime("in 5 minutes");
    const after = Date.now();

    expect(parsed).not.toBeNull();
    expect(parsed as number).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(parsed as number).toBeLessThanOrEqual(after + 5 * 60_000 + 2_000);
  });

  it("parses relative hour expressions", () => {
    const before = Date.now();
    const parsed = parseRelativeTime("in 2 hours");
    const after = Date.now();

    expect(parsed).not.toBeNull();
    expect(parsed as number).toBeGreaterThanOrEqual(before + 2 * 3_600_000);
    expect(parsed as number).toBeLessThanOrEqual(after + 2 * 3_600_000 + 2_000);
  });

  it("parses relative day expressions", () => {
    const before = Date.now();
    const parsed = parseRelativeTime("in 3 days");
    const after = Date.now();

    expect(parsed).not.toBeNull();
    expect(parsed as number).toBeGreaterThanOrEqual(before + 3 * 86_400_000);
    expect(parsed as number).toBeLessThanOrEqual(after + 3 * 86_400_000 + 2_000);
  });

  it("parses time-of-day expression with meridiem", () => {
    const parsed = parseRelativeTime("at 3pm");
    expect(parsed).not.toBeNull();

    const date = new Date(parsed as number);
    expect(date.getHours()).toBe(15);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses time-of-day expression with 24-hour format", () => {
    const parsed = parseRelativeTime("at 15:30");
    expect(parsed).not.toBeNull();

    const date = new Date(parsed as number);
    expect(date.getHours()).toBe(15);
    expect(date.getMinutes()).toBe(30);
  });

  it("parses tomorrow and applies default time", () => {
    const now = new Date();
    const parsed = parseRelativeTime("tomorrow");
    expect(parsed).not.toBeNull();

    const date = new Date(parsed as number);
    expect(dayDifference(now, date)).toBe(1);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses tomorrow with specific time", () => {
    const now = new Date();
    const parsed = parseRelativeTime("tomorrow at 3pm");
    expect(parsed).not.toBeNull();

    const date = new Date(parsed as number);
    expect(dayDifference(now, date)).toBe(1);
    expect(date.getHours()).toBe(15);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses next weekday expression", () => {
    const parsed = parseRelativeTime("next Monday");
    expect(parsed).not.toBeNull();

    const date = new Date(parsed as number);
    expect(date.getDay()).toBe(1);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses next week expression", () => {
    const now = new Date();
    const parsed = parseRelativeTime("next week");
    expect(parsed).not.toBeNull();

    const date = new Date(parsed as number);
    expect(dayDifference(now, date)).toBe(7);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses ISO date time expression", () => {
    const parsed = parseRelativeTime("2026-02-15T10:00:00Z");
    expect(parsed).toBe(Date.parse("2026-02-15T10:00:00Z"));
  });

  it("returns null for unsupported text", () => {
    expect(parseRelativeTime("sometime soon")).toBeNull();
    expect(parseRelativeTime("at noonish")).toBeNull();
    expect(parseRelativeTime("in zero minutes")).toBeNull();
  });
});

function dayDifference(a: Date, b: Date): number {
  const start = new Date(a);
  start.setHours(0, 0, 0, 0);

  const end = new Date(b);
  end.setHours(0, 0, 0, 0);

  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}
