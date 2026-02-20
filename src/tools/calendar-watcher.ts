import type { CronScheduler } from "../cron/scheduler";

/**
 * Represents a calendar event with the minimum fields needed for reminder evaluation.
 */
export interface CalendarEvent {
  id: string;
  title: string;
  startTime: Date;
}

export interface CalendarReminderWatcherOptions {
  /** Minutes before event start to fire the reminder. Default: 15 */
  minutesBefore?: number;
  /** Poll interval in milliseconds. Default: 60000 (60s) */
  pollIntervalMs?: number;
  /** Callback invoked when a reminder should fire for an upcoming event. */
  onReminder: (event: CalendarEvent) => void;
  /** Injectable data source returning upcoming calendar events. */
  getUpcomingEvents: () => Promise<CalendarEvent[]>;
  /** Injectable clock for testability. */
  now?: () => Date;
}

const DEFAULT_MINUTES_BEFORE = 15;
const DEFAULT_POLL_INTERVAL_MS = 60_000;
const CRON_JOB_ID = "calendar-reminder-watcher";

export class CalendarReminderWatcher {
  private readonly minutesBefore: number;
  private readonly pollIntervalMs: number;
  private readonly onReminder: (event: CalendarEvent) => void;
  private readonly getUpcomingEvents: () => Promise<CalendarEvent[]>;
  private readonly now: () => Date;
  private readonly firedReminders = new Map<string, number>();
  private registered = false;

  constructor(options: CalendarReminderWatcherOptions) {
    this.minutesBefore = options.minutesBefore ?? DEFAULT_MINUTES_BEFORE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.onReminder = options.onReminder;
    this.getUpcomingEvents = options.getUpcomingEvents;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Registers the poll cycle as a recurring cron job via CronScheduler.
   * Uses a 1-minute cron schedule (`* * * * *`) to match the default 60s poll interval.
   */
  async start(scheduler: CronScheduler): Promise<void> {
    if (this.registered) {
      return;
    }

    const result = await scheduler.create({
      id: CRON_JOB_ID,
      name: "Calendar Reminder Watcher",
      description: "Polls upcoming calendar events and fires pre-event reminders",
      schedule: this.buildCronSchedule(),
      payload: {
        action: "calendar-reminder-poll",
        parameters: {},
      },
    });

    if (!result.ok) {
      throw new Error(`Failed to register calendar watcher cron job: ${result.error.message}`);
    }

    this.registered = true;
  }

  /**
   * Removes the cron job from the scheduler.
   */
  async stop(scheduler: CronScheduler): Promise<void> {
    if (!this.registered) {
      return;
    }

    await scheduler.remove(CRON_JOB_ID);
    this.registered = false;
  }

  /**
   * Polls upcoming events and fires reminder callbacks for events within the reminder window.
   * Exposed publicly for direct testing without requiring a running CronScheduler.
   */
  async poll(): Promise<void> {
    const events = await this.getUpcomingEvents();
    const currentTime = this.now().getTime();

    this.clearExpiredFiredReminders(currentTime);

    for (const event of events) {
      const reminderTime = event.startTime.getTime() - this.minutesBefore * 60 * 1000;

      if (this.isWithinReminderWindow(currentTime, reminderTime) && !this.hasFired(event.id)) {
        this.markFired(event.id, currentTime);
        this.onReminder(event);
      }
    }
  }

  /**
   * Returns whether the watcher is currently registered as a cron job.
   */
  isRegistered(): boolean {
    return this.registered;
  }

  private isWithinReminderWindow(currentTime: number, reminderTime: number): boolean {
    return currentTime >= reminderTime && currentTime < reminderTime + this.pollIntervalMs;
  }

  private hasFired(eventId: string): boolean {
    return this.firedReminders.has(eventId);
  }

  private markFired(eventId: string, currentTime: number): void {
    this.firedReminders.set(eventId, currentTime);
  }

  private clearExpiredFiredReminders(currentTime: number): void {
    const expiryThreshold = 2 * this.pollIntervalMs;

    for (const [eventId, firedAt] of this.firedReminders.entries()) {
      if (currentTime - firedAt > expiryThreshold) {
        this.firedReminders.delete(eventId);
      }
    }
  }

  /**
   * Builds a cron schedule string based on the poll interval.
   * Default 60s → every minute: `* * * * *`
   */
  private buildCronSchedule(): string {
    const intervalMinutes = Math.max(1, Math.round(this.pollIntervalMs / 60_000));
    if (intervalMinutes === 1) {
      return "* * * * *";
    }
    return `*/${intervalMinutes} * * * *`;
  }
}
