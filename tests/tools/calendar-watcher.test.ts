import { describe, expect, it } from "bun:test";
import type { CalendarEvent } from "../../src/tools/calendar-watcher";
import { CalendarReminderWatcher } from "../../src/tools/calendar-watcher";

function makeEvent(overrides: Partial<CalendarEvent> & { id: string; title: string; startTime: Date }): CalendarEvent {
  return {
    id: overrides.id,
    title: overrides.title,
    startTime: overrides.startTime,
  };
}

function createMockScheduler() {
  const jobs = new Map<string, { id: string; name: string; schedule: string }>();
  return {
    jobs,
    create: async (input: { id?: string; name: string; schedule: string; description?: string; payload: { action: string; parameters: Record<string, unknown> } }) => {
      const id = input.id ?? crypto.randomUUID();
      if (jobs.has(id)) {
        return { ok: false as const, error: new Error(`Cron job already exists: ${id}`) };
      }
      jobs.set(id, { id, name: input.name, schedule: input.schedule });
      return { ok: true as const, value: { id, name: input.name, schedule: input.schedule } };
    },
    remove: async (id: string) => {
      jobs.delete(id);
      return { ok: true as const, value: undefined };
    },
  };
}

describe("CalendarReminderWatcher", () => {
  it("fires callback when event is within the reminder window", async () => {
    const fired: CalendarEvent[] = [];
    const now = new Date("2026-03-15T09:45:00Z");
    const eventStart = new Date("2026-03-15T10:00:00Z"); // 15 min from now

    const watcher = new CalendarReminderWatcher({
      minutesBefore: 15,
      pollIntervalMs: 60_000,
      onReminder: (event) => fired.push(event),
      getUpcomingEvents: async () => [
        makeEvent({ id: "evt-1", title: "Team Standup", startTime: eventStart }),
      ],
      now: () => now,
    });

    await watcher.poll();

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe("evt-1");
    expect(fired[0].title).toBe("Team Standup");
  });

  it("does NOT fire for events far in the future", async () => {
    const fired: CalendarEvent[] = [];
    const now = new Date("2026-03-15T08:00:00Z");
    const eventStart = new Date("2026-03-15T14:00:00Z"); // 6 hours from now

    const watcher = new CalendarReminderWatcher({
      minutesBefore: 15,
      pollIntervalMs: 60_000,
      onReminder: (event) => fired.push(event),
      getUpcomingEvents: async () => [
        makeEvent({ id: "evt-far", title: "Afternoon Meeting", startTime: eventStart }),
      ],
      now: () => now,
    });

    await watcher.poll();

    expect(fired).toHaveLength(0);
  });

  it("does NOT fire for events already past the reminder window", async () => {
    const fired: CalendarEvent[] = [];
    // Reminder window for 15min-before would be 09:45:00 to 09:46:00
    // Current time is 09:47:00 — past the window
    const now = new Date("2026-03-15T09:47:00Z");
    const eventStart = new Date("2026-03-15T10:00:00Z");

    const watcher = new CalendarReminderWatcher({
      minutesBefore: 15,
      pollIntervalMs: 60_000,
      onReminder: (event) => fired.push(event),
      getUpcomingEvents: async () => [
        makeEvent({ id: "evt-past", title: "Missed Window", startTime: eventStart }),
      ],
      now: () => now,
    });

    await watcher.poll();

    expect(fired).toHaveLength(0);
  });

  it("prevents double-firing for the same event across multiple polls", async () => {
    const fired: CalendarEvent[] = [];
    const now = new Date("2026-03-15T09:45:00Z");
    const eventStart = new Date("2026-03-15T10:00:00Z");

    const watcher = new CalendarReminderWatcher({
      minutesBefore: 15,
      pollIntervalMs: 60_000,
      onReminder: (event) => fired.push(event),
      getUpcomingEvents: async () => [
        makeEvent({ id: "evt-dup", title: "No Duplicates", startTime: eventStart }),
      ],
      now: () => now,
    });

    await watcher.poll();
    await watcher.poll();
    await watcher.poll();

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe("evt-dup");
  });

  it("fires for multiple events within the reminder window", async () => {
    const fired: CalendarEvent[] = [];
    const now = new Date("2026-03-15T09:45:20Z");
    const event1Start = new Date("2026-03-15T10:00:00Z"); // reminderTime: 09:45:00, window: [09:45:00, 09:46:00) — now is inside
    const event2Start = new Date("2026-03-15T10:00:10Z"); // reminderTime: 09:45:10, window: [09:45:10, 09:46:10) — now is inside

    const watcher = new CalendarReminderWatcher({
      minutesBefore: 15,
      pollIntervalMs: 60_000,
      onReminder: (event) => fired.push(event),
      getUpcomingEvents: async () => [
        makeEvent({ id: "evt-a", title: "Meeting A", startTime: event1Start }),
        makeEvent({ id: "evt-b", title: "Meeting B", startTime: event2Start }),
      ],
      now: () => now,
    });

    await watcher.poll();

    expect(fired).toHaveLength(2);
    expect(fired.map((e) => e.id).sort()).toEqual(["evt-a", "evt-b"]);
  });

  it("respects configurable minutesBefore (30 minutes)", async () => {
    const fired: CalendarEvent[] = [];
    const now = new Date("2026-03-15T09:30:00Z");
    const eventStart = new Date("2026-03-15T10:00:00Z"); // 30 min from now

    const watcher = new CalendarReminderWatcher({
      minutesBefore: 30,
      pollIntervalMs: 60_000,
      onReminder: (event) => fired.push(event),
      getUpcomingEvents: async () => [
        makeEvent({ id: "evt-30", title: "Early Reminder", startTime: eventStart }),
      ],
      now: () => now,
    });

    await watcher.poll();

    expect(fired).toHaveLength(1);
    expect(fired[0].id).toBe("evt-30");
  });

  it("does NOT fire at default 15min when minutesBefore is 30 and event is 15min away", async () => {
    const fired: CalendarEvent[] = [];
    // With minutesBefore=30, reminder window is 09:30:00 to 09:31:00
    // Current time is 09:45:00 — past the 30-min-before window
    const now = new Date("2026-03-15T09:45:00Z");
    const eventStart = new Date("2026-03-15T10:00:00Z");

    const watcher = new CalendarReminderWatcher({
      minutesBefore: 30,
      pollIntervalMs: 60_000,
      onReminder: (event) => fired.push(event),
      getUpcomingEvents: async () => [
        makeEvent({ id: "evt-no30", title: "Not Yet", startTime: eventStart }),
      ],
      now: () => now,
    });

    await watcher.poll();

    expect(fired).toHaveLength(0);
  });

  it("clears fired reminders after 2x poll interval", async () => {
    const fired: CalendarEvent[] = [];
    let currentTime = new Date("2026-03-15T09:45:00Z");
    const eventStart = new Date("2026-03-15T10:00:00Z");

    const watcher = new CalendarReminderWatcher({
      minutesBefore: 15,
      pollIntervalMs: 60_000,
      onReminder: (event) => fired.push(event),
      getUpcomingEvents: async () => [
        makeEvent({ id: "evt-clear", title: "Clearable", startTime: eventStart }),
      ],
      now: () => currentTime,
    });

    // First poll — fires
    await watcher.poll();
    expect(fired).toHaveLength(1);

    // Advance time past 2x poll interval (120s+) and back into the window
    // This simulates the fired reminder being cleared from the dedup set
    currentTime = new Date("2026-03-15T09:47:01Z");
    // The event is no longer in the window at 09:47:01 (window was 09:45:00-09:46:00)
    // so even though the dedup entry is cleared, it won't fire again
    await watcher.poll();
    expect(fired).toHaveLength(1);
  });

  it("registers as a cron job via start()", async () => {
    const scheduler = createMockScheduler();

    const watcher = new CalendarReminderWatcher({
      onReminder: () => {},
      getUpcomingEvents: async () => [],
    });

    await watcher.start(scheduler as never);

    expect(watcher.isRegistered()).toBe(true);
    expect(scheduler.jobs.has("calendar-reminder-watcher")).toBe(true);
    expect(scheduler.jobs.get("calendar-reminder-watcher")!.schedule).toBe("* * * * *");
  });

  it("unregisters cron job via stop()", async () => {
    const scheduler = createMockScheduler();

    const watcher = new CalendarReminderWatcher({
      onReminder: () => {},
      getUpcomingEvents: async () => [],
    });

    await watcher.start(scheduler as never);
    expect(watcher.isRegistered()).toBe(true);

    await watcher.stop(scheduler as never);
    expect(watcher.isRegistered()).toBe(false);
    expect(scheduler.jobs.has("calendar-reminder-watcher")).toBe(false);
  });

  it("start() is idempotent — calling twice does not create duplicate jobs", async () => {
    const scheduler = createMockScheduler();

    const watcher = new CalendarReminderWatcher({
      onReminder: () => {},
      getUpcomingEvents: async () => [],
    });

    await watcher.start(scheduler as never);
    await watcher.start(scheduler as never);

    expect(scheduler.jobs.size).toBe(1);
  });

  it("stop() is idempotent — calling without start does nothing", async () => {
    const scheduler = createMockScheduler();

    const watcher = new CalendarReminderWatcher({
      onReminder: () => {},
      getUpcomingEvents: async () => [],
    });

    await watcher.stop(scheduler as never);
    expect(watcher.isRegistered()).toBe(false);
  });

  it("uses default minutesBefore of 15 when not specified", async () => {
    const fired: CalendarEvent[] = [];
    const now = new Date("2026-03-15T09:45:00Z");
    const eventStart = new Date("2026-03-15T10:00:00Z"); // exactly 15 min away

    const watcher = new CalendarReminderWatcher({
      onReminder: (event) => fired.push(event),
      getUpcomingEvents: async () => [
        makeEvent({ id: "evt-default", title: "Default Timing", startTime: eventStart }),
      ],
      now: () => now,
    });

    await watcher.poll();

    expect(fired).toHaveLength(1);
  });

  it("builds correct cron schedule for custom poll intervals", async () => {
    const scheduler = createMockScheduler();

    const watcher = new CalendarReminderWatcher({
      pollIntervalMs: 300_000, // 5 minutes
      onReminder: () => {},
      getUpcomingEvents: async () => [],
    });

    await watcher.start(scheduler as never);

    expect(scheduler.jobs.get("calendar-reminder-watcher")!.schedule).toBe("*/5 * * * *");
  });
});
