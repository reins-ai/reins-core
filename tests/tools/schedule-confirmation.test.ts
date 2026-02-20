import { describe, expect, it } from "bun:test";

import { formatScheduleConfirmation } from "../../src/tools/schedule-confirmation";
import type { NlTimeResult } from "../../src/tools/date-parser";

describe("formatScheduleConfirmation", () => {
  it("formats recurring high-confidence result", () => {
    const result: NlTimeResult = {
      type: "recurring",
      cron: "0 9 * * 1",
      confidence: "high",
      humanReadable: "every Monday at 9:00 AM",
    };

    const confirmation = formatScheduleConfirmation(result);

    expect(confirmation).toBe(
      "I'll do this every Monday at 9:00 AM. Say 'cancel task' to stop it.",
    );
  });

  it("formats recurring low-confidence result with note", () => {
    const result: NlTimeResult = {
      type: "recurring",
      cron: "0 9 * * 1",
      confidence: "low",
      humanReadable: "every other Monday (best guess: every Monday at 9:00 AM)",
    };

    const confirmation = formatScheduleConfirmation(result);

    expect(confirmation).toContain("I'll do this every other Monday");
    expect(confirmation).toContain("Say 'cancel task' to stop it.");
    expect(confirmation).toContain("(Note: I interpreted this as");
    expect(confirmation).toContain("let me know if that's wrong.)");
  });

  it("formats one-time result for today", () => {
    const today = new Date();
    today.setHours(17, 30, 0, 0);

    const result: NlTimeResult = {
      type: "once",
      runAt: today,
      confidence: "high",
      humanReadable: "today at 5:30 PM",
    };

    const confirmation = formatScheduleConfirmation(result);

    expect(confirmation).toMatch(/^I'll remind you today at 5:30 PM\.$/);
  });

  it("formats one-time result for tomorrow", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(15, 0, 0, 0);

    const result: NlTimeResult = {
      type: "once",
      runAt: tomorrow,
      confidence: "high",
      humanReadable: "tomorrow at 3:00 PM",
    };

    const confirmation = formatScheduleConfirmation(result);

    expect(confirmation).toMatch(/^I'll remind you tomorrow at 3:00 PM\.$/);
  });

  it("formats one-time result for a future date", () => {
    const future = new Date();
    future.setDate(future.getDate() + 10);
    future.setHours(15, 0, 0, 0);

    const result: NlTimeResult = {
      type: "once",
      runAt: future,
      confidence: "high",
      humanReadable: `${future.toLocaleDateString("en-US", { weekday: "long" })}, ${future.toLocaleDateString("en-US", { month: "short" })} ${future.getDate()} at 3:00 PM`,
    };

    const confirmation = formatScheduleConfirmation(result);

    expect(confirmation).toStartWith("I'll remind you on ");
    expect(confirmation).toContain("at 3:00 PM.");
    expect(confirmation).not.toContain("today");
    expect(confirmation).not.toContain("tomorrow");
  });

  it("formats one-time result with no runAt using humanReadable fallback", () => {
    const result: NlTimeResult = {
      type: "once",
      confidence: "high",
      humanReadable: "Friday, Feb 21 at 3:00 PM",
    };

    const confirmation = formatScheduleConfirmation(result);

    expect(confirmation).toBe("I'll remind you on Friday, Feb 21 at 3:00 PM.");
  });

  it("formats one-time low-confidence result with note", () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);

    const result: NlTimeResult = {
      type: "once",
      runAt: tomorrow,
      confidence: "low",
      humanReadable: "tomorrow at 9:00 AM",
    };

    const confirmation = formatScheduleConfirmation(result);

    expect(confirmation).toContain("I'll remind you tomorrow at 9:00 AM.");
    expect(confirmation).toContain("(Note: I interpreted this as 'tomorrow at 9:00 AM'");
    expect(confirmation).toContain("let me know if that's wrong.)");
  });

  it("formats recurring twice-daily result", () => {
    const result: NlTimeResult = {
      type: "recurring",
      cron: "0 8,20 * * *",
      confidence: "high",
      humanReadable: "twice daily (8:00 AM and 8:00 PM)",
    };

    const confirmation = formatScheduleConfirmation(result);

    expect(confirmation).toBe(
      "I'll do this twice daily (8:00 AM and 8:00 PM). Say 'cancel task' to stop it.",
    );
  });
});
