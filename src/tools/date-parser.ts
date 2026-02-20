const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const RELATIVE_PATTERN = /^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)$/i;
const AT_TIME_PATTERN = /^at\s+(.+)$/i;
const TOMORROW_PATTERN = /^tomorrow(?:\s+at\s+(.+))?$/i;
const NEXT_WEEK_PATTERN = /^next\s+week(?:\s+at\s+(.+))?$/i;
const NEXT_WEEKDAY_PATTERN =
  /^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/i;
const ON_WEEKDAY_PATTERN =
  /^on\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/i;

const EVERY_DAY_PATTERN = /^(?:every\s+day|daily)$/i;
const EVERY_DAY_AT_TIME_PATTERN = /^(?:every\s+day|daily)\s+at\s+(.+)$/i;
const EVERY_HOUR_PATTERN = /^(?:every\s+hour|hourly)$/i;
const EVERY_N_MINUTES_PATTERN = /^every\s+(\d+)\s+minutes?$/i;
const EVERY_N_HOURS_PATTERN = /^every\s+(\d+)\s+hours?$/i;
const EVERY_N_DAYS_PATTERN = /^every\s+(\d+)\s+days?$/i;
const EVERY_N_WEEKS_PATTERN = /^every\s+(\d+)\s+weeks?$/i;
const EVERY_WEEKDAY_PATTERN = /^(?:every\s+weekday|weekdays)$/i;
const EVERY_WEEKEND_PATTERN = /^every\s+weekend$/i;
const EVERY_WEEKDAY_MORNING_PATTERN = /^every\s+weekday\s+morning$/i;
const EVERY_WEEKDAY_EVENING_PATTERN = /^every\s+weekday\s+evening$/i;
const EVERY_MORNING_PATTERN = /^every\s+morning$/i;
const EVERY_EVENING_PATTERN = /^(?:every\s+evening|every\s+night)$/i;
const TWICE_A_DAY_PATTERN = /^(?:twice\s+a\s+day|twice\s+daily)$/i;
const THREE_TIMES_A_DAY_PATTERN = /^three\s+times\s+a\s+day$/i;
const DAILY_AT_MIDNIGHT_PATTERN = /^(?:daily\s+at\s+midnight|every\s+midnight)$/i;
const DAILY_AT_NOON_PATTERN = /^(?:daily\s+at\s+noon|every\s+noon)$/i;
const WEEKLY_PATTERN = /^(?:weekly|every\s+week)$/i;
const MONTHLY_PATTERN = /^(?:monthly|every\s+month)$/i;
const FIRST_OF_MONTH_PATTERN = /^first\s+of\s+(?:every\s+month|the\s+month)$/i;
const ON_DAY_OF_MONTH_PATTERN = /^on\s+the\s+(\d{1,2})(?:st|nd|rd|th)?\s+of\s+every\s+month$/i;
const EVERY_WEEKDAY_AT_TIME_PATTERN =
  /^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+(.+)$/i;
const EVERY_WEEKDAY_DEFAULT_PATTERN =
  /^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
const EVERY_OTHER_WEEKDAY_PATTERN =
  /^every\s+other\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;
const EVERY_OTHER_WEEK_PATTERN = /^every\s+other\s+week$/i;
const EVERY_TWO_WEEKDAYS_PATTERN =
  /^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+and\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/i;

const WEEKDAY_TO_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

interface ParsedTimeOfDay {
  hours: number;
  minutes: number;
}

export interface NlTimeResult {
  type: "once" | "recurring";
  cron?: string;
  runAt?: Date;
  confidence: "high" | "low";
  humanReadable: string;
}

export function parseRelativeTime(input: string): NlTimeResult | null {
  const parsed = parseNlTime(input);
  if (!parsed || parsed.type !== "once") {
    return null;
  }

  return parsed;
}

export function parseNlTime(input: string): NlTimeResult | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const normalized = normalizeInput(trimmed);
  const lower = normalized.toLowerCase();
  const now = new Date();

  const isoDate = parseIsoDateTime(normalized);
  if (isoDate) {
    return onceResult(isoDate, "high");
  }

  const relativeMatch = lower.match(RELATIVE_PATTERN);
  if (relativeMatch) {
    const value = Number.parseInt(relativeMatch[1] ?? "", 10);
    const unit = relativeMatch[2]?.toLowerCase();

    if (!Number.isFinite(value) || value <= 0 || !unit) {
      return null;
    }

    return onceResult(new Date(now.getTime() + value * unitToMs(unit)), "high");
  }

  const atTimeMatch = lower.match(AT_TIME_PATTERN);
  if (atTimeMatch) {
    const parsed = parseTimeOfDay(atTimeMatch[1] ?? "");
    if (!parsed) {
      return null;
    }

    const scheduled = withTime(now, parsed);
    if (scheduled.getTime() <= now.getTime()) {
      scheduled.setDate(scheduled.getDate() + 1);
    }

    return onceResult(scheduled, "high");
  }

  const tomorrowMatch = lower.match(TOMORROW_PATTERN);
  if (tomorrowMatch) {
    const time = parseTimeOfDayOrDefault(tomorrowMatch[1]);
    if (!time) {
      return null;
    }

    const scheduled = new Date(now);
    scheduled.setDate(scheduled.getDate() + 1);
    scheduled.setHours(time.hours, time.minutes, 0, 0);
    return onceResult(scheduled, "high");
  }

  const nextWeekMatch = lower.match(NEXT_WEEK_PATTERN);
  if (nextWeekMatch) {
    const time = parseTimeOfDayOrDefault(nextWeekMatch[1]);
    if (!time) {
      return null;
    }

    const scheduled = new Date(now);
    scheduled.setDate(scheduled.getDate() + 7);
    scheduled.setHours(time.hours, time.minutes, 0, 0);
    return onceResult(scheduled, "high");
  }

  const nextWeekdayMatch = lower.match(NEXT_WEEKDAY_PATTERN);
  if (nextWeekdayMatch) {
    const weekday = nextWeekdayMatch[1]?.toLowerCase();
    const targetWeekday = weekday ? WEEKDAY_TO_INDEX[weekday] : undefined;

    if (targetWeekday === undefined) {
      return null;
    }

    const time = parseTimeOfDayOrDefault(nextWeekdayMatch[2]);
    if (!time) {
      return null;
    }

    const scheduled = nextWeekday(now, targetWeekday, time);
    return onceResult(scheduled, "high");
  }

  const onWeekdayMatch = lower.match(ON_WEEKDAY_PATTERN);
  if (onWeekdayMatch) {
    const weekday = onWeekdayMatch[1]?.toLowerCase();
    const targetWeekday = weekday ? WEEKDAY_TO_INDEX[weekday] : undefined;

    if (targetWeekday === undefined) {
      return null;
    }

    const time = parseTimeOfDayOrDefault(onWeekdayMatch[2]);
    if (!time) {
      return null;
    }

    const scheduled = upcomingWeekday(now, targetWeekday, time);
    return onceResult(scheduled, "high");
  }

  const everyTwoWeekdaysMatch = lower.match(EVERY_TWO_WEEKDAYS_PATTERN);
  if (everyTwoWeekdaysMatch) {
    const dayA = everyTwoWeekdaysMatch[1]?.toLowerCase();
    const dayB = everyTwoWeekdaysMatch[2]?.toLowerCase();
    const dowA = dayA ? WEEKDAY_TO_INDEX[dayA] : undefined;
    const dowB = dayB ? WEEKDAY_TO_INDEX[dayB] : undefined;
    if (dowA === undefined || dowB === undefined) {
      return null;
    }

    const time = parseTimeOfDayOrDefault(everyTwoWeekdaysMatch[3]);
    if (!time) {
      return null;
    }

    const cron = `${time.minutes} ${time.hours} * * ${dowA},${dowB}`;
    return recurringResult(
      cron,
      `every ${capitalize(dayA!)} and ${capitalize(dayB!)} at ${formatTime(time)}`,
      "high",
    );
  }

  const everyWeekdayAtTimeMatch = lower.match(EVERY_WEEKDAY_AT_TIME_PATTERN);
  if (everyWeekdayAtTimeMatch) {
    const weekday = everyWeekdayAtTimeMatch[1]?.toLowerCase();
    const targetWeekday = weekday ? WEEKDAY_TO_INDEX[weekday] : undefined;
    if (targetWeekday === undefined) {
      return null;
    }

    const time = parseTimeOfDay(everyWeekdayAtTimeMatch[2] ?? "");
    if (!time) {
      return null;
    }

    const cron = `${time.minutes} ${time.hours} * * ${targetWeekday}`;
    return recurringResult(cron, `every ${capitalize(weekday!)} at ${formatTime(time)}`, "high");
  }

  const everyWeekdayDefaultMatch = lower.match(EVERY_WEEKDAY_DEFAULT_PATTERN);
  if (everyWeekdayDefaultMatch) {
    const weekday = everyWeekdayDefaultMatch[1]?.toLowerCase();
    const targetWeekday = weekday ? WEEKDAY_TO_INDEX[weekday] : undefined;
    if (targetWeekday === undefined) {
      return null;
    }

    return recurringResult(`0 9 * * ${targetWeekday}`, `every ${capitalize(weekday!)} at 9:00 AM`, "high");
  }

  const everyOtherWeekdayMatch = lower.match(EVERY_OTHER_WEEKDAY_PATTERN);
  if (everyOtherWeekdayMatch) {
    const weekday = everyOtherWeekdayMatch[1]?.toLowerCase();
    const targetWeekday = weekday ? WEEKDAY_TO_INDEX[weekday] : undefined;
    if (targetWeekday === undefined) {
      return null;
    }

    return recurringResult(
      `0 9 * * ${targetWeekday}`,
      `every other ${weekday} (best guess: every ${capitalize(weekday!)} at 9:00 AM)`,
      "low",
    );
  }

  if (EVERY_DAY_AT_TIME_PATTERN.test(lower)) {
    const match = lower.match(EVERY_DAY_AT_TIME_PATTERN);
    const time = parseTimeOfDay(match?.[1] ?? "");
    if (!time) {
      return null;
    }

    return recurringResult(
      `${time.minutes} ${time.hours} * * *`,
      `every day at ${formatTime(time)}`,
      "high",
    );
  }

  if (EVERY_DAY_PATTERN.test(lower)) {
    return recurringResult("0 0 * * *", "every day at 12:00 AM", "high");
  }

  if (EVERY_HOUR_PATTERN.test(lower)) {
    return recurringResult("0 * * * *", "every hour", "high");
  }

  const everyNMinutesMatch = lower.match(EVERY_N_MINUTES_PATTERN);
  if (everyNMinutesMatch) {
    const interval = Number.parseInt(everyNMinutesMatch[1] ?? "", 10);
    if (!Number.isFinite(interval) || interval <= 0 || interval > 59) {
      return null;
    }

    return recurringResult(`*/${interval} * * * *`, `every ${interval} minutes`, "high");
  }

  const everyNHoursMatch = lower.match(EVERY_N_HOURS_PATTERN);
  if (everyNHoursMatch) {
    const interval = Number.parseInt(everyNHoursMatch[1] ?? "", 10);
    if (!Number.isFinite(interval) || interval <= 0 || interval > 23) {
      return null;
    }

    return recurringResult(`0 */${interval} * * *`, `every ${interval} hours`, "high");
  }

  const everyNDaysMatch = lower.match(EVERY_N_DAYS_PATTERN);
  if (everyNDaysMatch) {
    const interval = Number.parseInt(everyNDaysMatch[1] ?? "", 10);
    if (!Number.isFinite(interval) || interval <= 0 || interval > 31) {
      return null;
    }

    return recurringResult(`0 0 */${interval} * *`, `every ${interval} days`, "high");
  }

  const everyNWeeksMatch = lower.match(EVERY_N_WEEKS_PATTERN);
  if (everyNWeeksMatch) {
    const interval = Number.parseInt(everyNWeeksMatch[1] ?? "", 10);
    if (!Number.isFinite(interval) || interval <= 0) {
      return null;
    }

    return recurringResult(
      "0 9 * * 1",
      `every ${interval} weeks (best guess: every Monday at 9:00 AM)`,
      "low",
    );
  }

  if (EVERY_WEEKDAY_PATTERN.test(lower)) {
    return recurringResult("0 9 * * 1-5", "every weekday at 9:00 AM", "high");
  }

  if (EVERY_WEEKEND_PATTERN.test(lower)) {
    return recurringResult("0 9 * * 0,6", "every weekend at 9:00 AM", "high");
  }

  if (EVERY_WEEKDAY_MORNING_PATTERN.test(lower)) {
    return recurringResult("0 8 * * 1-5", "every weekday morning at 8:00 AM", "high");
  }

  if (EVERY_WEEKDAY_EVENING_PATTERN.test(lower)) {
    return recurringResult("0 18 * * 1-5", "every weekday evening at 6:00 PM", "high");
  }

  if (EVERY_MORNING_PATTERN.test(lower)) {
    return recurringResult("0 8 * * *", "every morning at 8:00 AM", "high");
  }

  if (EVERY_EVENING_PATTERN.test(lower)) {
    return recurringResult("0 20 * * *", "every evening at 8:00 PM", "high");
  }

  if (TWICE_A_DAY_PATTERN.test(lower)) {
    return recurringResult("0 8,20 * * *", "twice daily (8:00 AM and 8:00 PM)", "high");
  }

  if (THREE_TIMES_A_DAY_PATTERN.test(lower)) {
    return recurringResult(
      "0 8,13,20 * * *",
      "three times daily (8:00 AM, 1:00 PM, and 8:00 PM)",
      "high",
    );
  }

  if (DAILY_AT_MIDNIGHT_PATTERN.test(lower)) {
    return recurringResult("0 0 * * *", "daily at midnight", "high");
  }

  if (DAILY_AT_NOON_PATTERN.test(lower)) {
    return recurringResult("0 12 * * *", "daily at noon", "high");
  }

  if (WEEKLY_PATTERN.test(lower)) {
    return recurringResult("0 9 * * 1", "every week on Monday at 9:00 AM", "high");
  }

  if (MONTHLY_PATTERN.test(lower)) {
    return recurringResult("0 9 1 * *", "every month on the 1st at 9:00 AM", "high");
  }

  if (FIRST_OF_MONTH_PATTERN.test(lower)) {
    return recurringResult("0 9 1 * *", "first day of every month at 9:00 AM", "high");
  }

  const onDayOfMonthMatch = lower.match(ON_DAY_OF_MONTH_PATTERN);
  if (onDayOfMonthMatch) {
    const day = Number.parseInt(onDayOfMonthMatch[1] ?? "", 10);
    if (!Number.isFinite(day) || day < 1 || day > 31) {
      return null;
    }

    return recurringResult(`0 9 ${day} * *`, `every month on day ${day} at 9:00 AM`, "high");
  }

  if (EVERY_OTHER_WEEK_PATTERN.test(lower)) {
    return recurringResult(
      "0 9 * * 1",
      "every other week (best guess: every Monday at 9:00 AM)",
      "low",
    );
  }

  return null;
}

function normalizeInput(input: string): string {
  return input.trim().replace(/^remind\s+me\s+/i, "");
}

function parseIsoDateTime(input: string): Date | null {
  if (!ISO_DATE_TIME_PATTERN.test(input)) {
    return null;
  }

  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return new Date(timestamp);
}

function parseTimeOfDayOrDefault(value: string | undefined): ParsedTimeOfDay | null {
  if (!value) {
    return { hours: 9, minutes: 0 };
  }

  return parseTimeOfDay(value);
}

function parseTimeOfDay(input: string): ParsedTimeOfDay | null {
  const cleaned = input.trim().toLowerCase();
  if (cleaned.length === 0) {
    return null;
  }

  if (cleaned === "noon") {
    return { hours: 12, minutes: 0 };
  }

  if (cleaned === "midnight") {
    return { hours: 0, minutes: 0 };
  }

  const twelveHourMatch = cleaned.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (twelveHourMatch) {
    const rawHours = Number.parseInt(twelveHourMatch[1] ?? "", 10);
    const rawMinutes = Number.parseInt(twelveHourMatch[2] ?? "0", 10);
    const suffix = twelveHourMatch[3]?.toLowerCase();

    if (!Number.isFinite(rawHours) || rawHours < 1 || rawHours > 12) {
      return null;
    }

    if (!Number.isFinite(rawMinutes) || rawMinutes < 0 || rawMinutes > 59 || !suffix) {
      return null;
    }

    const normalizedHours = rawHours % 12 + (suffix === "pm" ? 12 : 0);
    return { hours: normalizedHours, minutes: rawMinutes };
  }

  const twentyFourHourMatch = cleaned.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch) {
    const hours = Number.parseInt(twentyFourHourMatch[1] ?? "", 10);
    const minutes = Number.parseInt(twentyFourHourMatch[2] ?? "", 10);

    if (
      !Number.isFinite(hours) ||
      !Number.isFinite(minutes) ||
      hours < 0 ||
      hours > 23 ||
      minutes < 0 ||
      minutes > 59
    ) {
      return null;
    }

    return { hours, minutes };
  }

  return null;
}

function withTime(source: Date, time: ParsedTimeOfDay): Date {
  const next = new Date(source);
  next.setHours(time.hours, time.minutes, 0, 0);
  return next;
}

function nextWeekday(source: Date, targetDay: number, time: ParsedTimeOfDay): Date {
  const next = new Date(source);
  const currentDay = next.getDay();

  let daysToAdd = (targetDay - currentDay + 7) % 7;
  if (daysToAdd === 0) {
    daysToAdd = 7;
  }

  next.setDate(next.getDate() + daysToAdd);
  next.setHours(time.hours, time.minutes, 0, 0);
  return next;
}

function upcomingWeekday(source: Date, targetDay: number, time: ParsedTimeOfDay): Date {
  const next = new Date(source);
  const currentDay = next.getDay();

  let daysToAdd = (targetDay - currentDay + 7) % 7;
  next.setDate(next.getDate() + daysToAdd);
  next.setHours(time.hours, time.minutes, 0, 0);

  if (daysToAdd === 0 && next.getTime() <= source.getTime()) {
    next.setDate(next.getDate() + 7);
  }

  return next;
}

function onceResult(runAt: Date, confidence: "high" | "low"): NlTimeResult {
  return {
    type: "once",
    runAt,
    confidence,
    humanReadable: formatOnceHumanReadable(runAt),
  };
}

function recurringResult(
  cron: string,
  humanReadable: string,
  confidence: "high" | "low",
): NlTimeResult {
  return {
    type: "recurring",
    cron,
    confidence,
    humanReadable,
  };
}

function formatOnceHumanReadable(date: Date): string {
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" });
  const monthDay = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  return `${weekday}, ${monthDay} at ${time}`;
}

function formatTime(time: ParsedTimeOfDay): string {
  const sample = new Date(2000, 0, 1, time.hours, time.minutes, 0, 0);
  return sample.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function capitalize(value: string): string {
  if (value.length === 0) {
    return value;
  }

  return value[0]!.toUpperCase() + value.slice(1);
}

function unitToMs(unit: string): number {
  switch (unit) {
    case "minute":
    case "minutes":
      return 60_000;
    case "hour":
    case "hours":
      return 3_600_000;
    case "day":
    case "days":
      return 86_400_000;
    case "week":
    case "weeks":
      return 604_800_000;
    default:
      return 0;
  }
}
