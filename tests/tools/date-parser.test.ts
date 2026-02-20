import { describe, expect, it } from "bun:test";

import { parseNlTime, parseRelativeTime } from "../../src/tools/date-parser";

describe("parseRelativeTime", () => {
  it("parses relative minute expressions", () => {
    const before = Date.now();
    const parsed = parseRelativeTime("in 5 minutes");
    const after = Date.now();

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("once");
    expect(parsed?.runAt?.getTime()).toBeGreaterThanOrEqual(before + 5 * 60_000);
    expect(parsed?.runAt?.getTime()).toBeLessThanOrEqual(after + 5 * 60_000 + 2_000);
  });

  it("parses relative hour expressions", () => {
    const before = Date.now();
    const parsed = parseRelativeTime("in 2 hours");
    const after = Date.now();

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("once");
    expect(parsed?.runAt?.getTime()).toBeGreaterThanOrEqual(before + 2 * 3_600_000);
    expect(parsed?.runAt?.getTime()).toBeLessThanOrEqual(after + 2 * 3_600_000 + 2_000);
  });

  it("parses relative day expressions", () => {
    const before = Date.now();
    const parsed = parseRelativeTime("in 3 days");
    const after = Date.now();

    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("once");
    expect(parsed?.runAt?.getTime()).toBeGreaterThanOrEqual(before + 3 * 86_400_000);
    expect(parsed?.runAt?.getTime()).toBeLessThanOrEqual(after + 3 * 86_400_000 + 2_000);
  });

  it("parses time-of-day expression with meridiem", () => {
    const parsed = parseRelativeTime("at 3pm");
    expect(parsed).not.toBeNull();

    const date = parsed?.runAt as Date;
    expect(date.getHours()).toBe(15);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses time-of-day expression with 24-hour format", () => {
    const parsed = parseRelativeTime("at 15:30");
    expect(parsed).not.toBeNull();

    const date = parsed?.runAt as Date;
    expect(date.getHours()).toBe(15);
    expect(date.getMinutes()).toBe(30);
  });

  it("parses tomorrow and applies default time", () => {
    const now = new Date();
    const parsed = parseRelativeTime("tomorrow");
    expect(parsed).not.toBeNull();

    const date = parsed?.runAt as Date;
    expect(dayDifference(now, date)).toBe(1);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses tomorrow with specific time", () => {
    const now = new Date();
    const parsed = parseRelativeTime("tomorrow at 3pm");
    expect(parsed).not.toBeNull();

    const date = parsed?.runAt as Date;
    expect(dayDifference(now, date)).toBe(1);
    expect(date.getHours()).toBe(15);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses next weekday expression", () => {
    const parsed = parseRelativeTime("next Monday");
    expect(parsed).not.toBeNull();

    const date = parsed?.runAt as Date;
    expect(date.getDay()).toBe(1);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses next week expression", () => {
    const now = new Date();
    const parsed = parseRelativeTime("next week");
    expect(parsed).not.toBeNull();

    const date = parsed?.runAt as Date;
    expect(dayDifference(now, date)).toBe(7);
    expect(date.getHours()).toBe(9);
    expect(date.getMinutes()).toBe(0);
  });

  it("parses ISO date time expression", () => {
    const parsed = parseRelativeTime("2026-02-15T10:00:00Z");
    expect(parsed?.runAt?.getTime()).toBe(Date.parse("2026-02-15T10:00:00Z"));
  });

  it("returns null for recurring expressions", () => {
    expect(parseRelativeTime("every weekday")).toBeNull();
  });

  it("returns null for unsupported text", () => {
    expect(parseRelativeTime("sometime soon")).toBeNull();
    expect(parseRelativeTime("at noonish")).toBeNull();
    expect(parseRelativeTime("in zero minutes")).toBeNull();
  });
});

describe("parseNlTime recurring patterns", () => {
  it("parses 20+ recurring expressions to cron", () => {
    expectRecurring("every day", "0 0 * * *");
    expectRecurring("daily", "0 0 * * *");
    expectRecurring("every hour", "0 * * * *");
    expectRecurring("hourly", "0 * * * *");
    expectRecurring("every 15 minutes", "*/15 * * * *");
    expectRecurring("every 2 hours", "0 */2 * * *");
    expectRecurring("every 3 days", "0 0 */3 * *");
    expectRecurring("every monday", "0 9 * * 1");
    expectRecurring("every monday at 9am", "0 9 * * 1");
    expectRecurring("every friday at 4pm", "0 16 * * 5");
    expectRecurring("every weekday", "0 9 * * 1-5");
    expectRecurring("weekdays", "0 9 * * 1-5");
    expectRecurring("every weekend", "0 9 * * 0,6");
    expectRecurring("every weekday morning", "0 8 * * 1-5");
    expectRecurring("every weekday evening", "0 18 * * 1-5");
    expectRecurring("every morning", "0 8 * * *");
    expectRecurring("every evening", "0 20 * * *");
    expectRecurring("every night", "0 20 * * *");
    expectRecurring("twice a day", "0 8,20 * * *");
    expectRecurring("twice daily", "0 8,20 * * *");
    expectRecurring("three times a day", "0 8,13,20 * * *");
    expectRecurring("daily at midnight", "0 0 * * *");
    expectRecurring("every midnight", "0 0 * * *");
    expectRecurring("daily at noon", "0 12 * * *");
    expectRecurring("every noon", "0 12 * * *");
    expectRecurring("weekly", "0 9 * * 1");
    expectRecurring("every week", "0 9 * * 1");
    expectRecurring("monthly", "0 9 1 * *");
    expectRecurring("every month", "0 9 1 * *");
    expectRecurring("first of every month", "0 9 1 * *");
    expectRecurring("first of the month", "0 9 1 * *");
    expectRecurring("on the 15th of every month", "0 9 15 * *");
    expectRecurring("every tuesday and thursday at 3pm", "0 15 * * 2,4");
  });

  it("returns low confidence for ambiguous recurring expressions", () => {
    expectRecurring("every other monday", "0 9 * * 1", "low");
    expectRecurring("every other week", "0 9 * * 1", "low");
    expectRecurring("every 2 weeks", "0 9 * * 1", "low");
  });
});

describe("parseNlTime one-time patterns", () => {
  it("parses one-time natural language inputs", () => {
    expect(parseNlTime("remind me in 10 minutes")?.type).toBe("once");
    expect(parseNlTime("tomorrow at 9am")?.type).toBe("once");
    expect(parseNlTime("next monday at noon")?.type).toBe("once");
    expect(parseNlTime("on friday at 8:30")?.type).toBe("once");
    expect(parseNlTime("2026-02-15T10:00:00Z")?.type).toBe("once");
  });
});

function dayDifference(a: Date, b: Date): number {
  const start = new Date(a);
  start.setHours(0, 0, 0, 0);

  const end = new Date(b);
  end.setHours(0, 0, 0, 0);

  return Math.round((end.getTime() - start.getTime()) / 86_400_000);
}

function expectRecurring(
  input: string,
  expectedCron: string,
  expectedConfidence: "high" | "low" = "high",
): void {
  const parsed = parseNlTime(input);
  expect(parsed).not.toBeNull();
  expect(parsed?.type).toBe("recurring");
  expect(parsed?.cron).toBe(expectedCron);
  expect(parsed?.confidence).toBe(expectedConfidence);
  expect(parsed?.humanReadable.length).toBeGreaterThan(0);
}
