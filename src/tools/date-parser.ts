const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T\s]\d{2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const RELATIVE_PATTERN = /^in\s+(\d+)\s+(minute|minutes|hour|hours|day|days|week|weeks)$/i;
const AT_TIME_PATTERN = /^at\s+(.+)$/i;
const TOMORROW_PATTERN = /^tomorrow(?:\s+at\s+(.+))?$/i;
const NEXT_WEEK_PATTERN = /^next\s+week(?:\s+at\s+(.+))?$/i;
const NEXT_WEEKDAY_PATTERN =
  /^next\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+at\s+(.+))?$/i;

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

export function parseRelativeTime(input: string): number | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  const now = new Date();

  const isoTimestamp = parseIsoDateTime(trimmed);
  if (isoTimestamp !== null) {
    return isoTimestamp;
  }

  const relativeMatch = lower.match(RELATIVE_PATTERN);
  if (relativeMatch) {
    const value = Number.parseInt(relativeMatch[1] ?? "", 10);
    const unit = relativeMatch[2]?.toLowerCase();

    if (!Number.isFinite(value) || value <= 0 || !unit) {
      return null;
    }

    return now.getTime() + value * unitToMs(unit);
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

    return scheduled.getTime();
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
    return scheduled.getTime();
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
    return scheduled.getTime();
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
    return scheduled.getTime();
  }

  return null;
}

function parseIsoDateTime(input: string): number | null {
  if (!ISO_DATE_TIME_PATTERN.test(input)) {
    return null;
  }

  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return timestamp;
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
