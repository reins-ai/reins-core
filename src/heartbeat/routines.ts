/**
 * Routine due-evaluation for heartbeat-driven recurring rituals.
 *
 * Parses ROUTINES.md into structured routine objects and evaluates
 * which routines are due based on current time and last heartbeat.
 */

export type RoutineFrequency = "daily" | "weekly" | "custom";

export interface Routine {
  name: string;
  triggerTime: string;
  frequency: RoutineFrequency;
  dayOfWeek?: number;
  outputContract: string[];
  actions: string[];
}

export interface DueRoutine {
  routine: Routine;
  reason: string;
}

interface ParsedTrigger {
  time: string;
  frequency: RoutineFrequency;
  dayOfWeek?: number;
  daysOfWeek?: number[];
}

const DAY_NAMES: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const WEEKDAY_NUMBERS = [1, 2, 3, 4, 5];

/**
 * Parse a trigger line like:
 *   "First heartbeat after 7:00 AM on weekdays"
 *   "First heartbeat after 5:00 PM on Sunday"
 *   "First heartbeat after 6:00 PM on weekdays"
 */
function parseTrigger(triggerLine: string): ParsedTrigger | null {
  const timeMatch = triggerLine.match(/(\d{1,2}:\d{2}\s*(?:AM|PM))/i);
  if (!timeMatch) {
    return null;
  }

  const time = timeMatch[1].trim();
  const lowerLine = triggerLine.toLowerCase();

  if (lowerLine.includes("weekday")) {
    return { time, frequency: "daily", daysOfWeek: WEEKDAY_NUMBERS };
  }

  for (const [dayName, dayNumber] of Object.entries(DAY_NAMES)) {
    if (lowerLine.includes(dayName)) {
      return { time, frequency: "weekly", dayOfWeek: dayNumber };
    }
  }

  return { time, frequency: "daily" };
}

/**
 * Parse a 12-hour time string (e.g. "7:00 AM") into { hours, minutes } in 24-hour format.
 */
function parseTime(timeStr: string): { hours: number; minutes: number } | null {
  const match = timeStr.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) {
    return null;
  }

  let hours = parseInt(match[1], 10);
  const minutes = parseInt(match[2], 10);
  const period = match[3].toUpperCase();

  if (period === "PM" && hours !== 12) {
    hours += 12;
  } else if (period === "AM" && hours === 12) {
    hours = 0;
  }

  return { hours, minutes };
}

/**
 * Parse ROUTINES.md markdown content into structured Routine objects.
 *
 * Expects H2 sections with **Trigger:**, **Output Contract:**, and **Actions:** fields.
 * Skips template/comment sections and informational headings.
 */
export function parseRoutines(markdownContent: string): Routine[] {
  const routines: Routine[] = [];
  const lines = markdownContent.split("\n");

  let currentName: string | null = null;
  let triggerLine = "";
  let outputContract: string[] = [];
  let actions: string[] = [];
  let inOutputContract = false;
  let inActions = false;
  let inComment = false;
  let inExampleOutput = false;

  const flushRoutine = () => {
    if (!currentName || !triggerLine) {
      currentName = null;
      triggerLine = "";
      outputContract = [];
      actions = [];
      return;
    }

    const parsed = parseTrigger(triggerLine);
    if (!parsed) {
      currentName = null;
      triggerLine = "";
      outputContract = [];
      actions = [];
      return;
    }

    const routine: Routine = {
      name: currentName,
      triggerTime: parsed.time,
      frequency: parsed.frequency,
      outputContract: [...outputContract],
      actions: [...actions],
    };

    if (parsed.dayOfWeek !== undefined) {
      routine.dayOfWeek = parsed.dayOfWeek;
    }

    if (parsed.daysOfWeek) {
      routine.dayOfWeek = undefined;
    }

    routines.push(routine);

    currentName = null;
    triggerLine = "";
    outputContract = [];
    actions = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "<!--") {
      inComment = true;
      continue;
    }
    if (trimmed === "-->" || trimmed.endsWith("-->")) {
      inComment = false;
      continue;
    }
    if (inComment) {
      continue;
    }

    if (trimmed.startsWith("```")) {
      inExampleOutput = !inExampleOutput;
      continue;
    }
    if (inExampleOutput) {
      continue;
    }

    if (trimmed.startsWith("## ") && !trimmed.startsWith("### ")) {
      flushRoutine();

      const heading = trimmed.replace(/^##\s+/, "").trim();
      const skipHeadings = [
        "how routines work",
        "custom routine template",
        "notes",
      ];
      if (skipHeadings.some((s) => heading.toLowerCase().startsWith(s))) {
        currentName = null;
        continue;
      }

      currentName = heading;
      inOutputContract = false;
      inActions = false;
      continue;
    }

    if (!currentName) {
      continue;
    }

    if (trimmed.startsWith("**Trigger:**")) {
      triggerLine = trimmed.replace("**Trigger:**", "").trim();
      inOutputContract = false;
      inActions = false;
      continue;
    }

    if (trimmed.startsWith("**Output Contract:**")) {
      inOutputContract = true;
      inActions = false;
      continue;
    }

    if (trimmed.startsWith("**Actions:**")) {
      inActions = true;
      inOutputContract = false;
      continue;
    }

    if (trimmed.startsWith("**Example Output:**") || trimmed.startsWith("**Example")) {
      inOutputContract = false;
      inActions = false;
      continue;
    }

    if (trimmed === "---") {
      inOutputContract = false;
      inActions = false;
      continue;
    }

    if (inOutputContract && trimmed.startsWith("- ")) {
      outputContract.push(trimmed.replace(/^-\s+/, ""));
      continue;
    }

    if (inActions && /^\d+\.\s/.test(trimmed)) {
      actions.push(trimmed.replace(/^\d+\.\s+/, ""));
      continue;
    }
  }

  flushRoutine();

  return routines;
}

/**
 * Determine which routines are due given the current time and last heartbeat time.
 *
 * A routine is due when:
 * - The current time is at or after the trigger time
 * - The last heartbeat was before the trigger time (or no last heartbeat today)
 * - For weekly routines, the current day matches the configured day of week
 * - For daily routines with weekday constraints, the current day is a weekday
 */
export function evaluateDue(
  routines: Routine[],
  now: Date,
  lastHeartbeat?: Date,
): DueRoutine[] {
  const dueRoutines: DueRoutine[] = [];
  const currentDay = now.getDay();

  for (const routine of routines) {
    const triggerTime = parseTime(routine.triggerTime);
    if (!triggerTime) {
      continue;
    }

    const triggerToday = new Date(now);
    triggerToday.setHours(triggerTime.hours, triggerTime.minutes, 0, 0);

    if (now < triggerToday) {
      continue;
    }

    if (routine.frequency === "weekly") {
      if (routine.dayOfWeek !== undefined && currentDay !== routine.dayOfWeek) {
        continue;
      }
    }

    if (routine.frequency === "daily") {
      const isDailyRoutine = isDailyWeekdayRoutine(routine);
      if (isDailyRoutine && !WEEKDAY_NUMBERS.includes(currentDay)) {
        continue;
      }
    }

    if (lastHeartbeat) {
      const lastHeartbeatSameDay = isSameDay(lastHeartbeat, now);
      if (lastHeartbeatSameDay && lastHeartbeat >= triggerToday) {
        continue;
      }
    }

    const reason = buildDueReason(routine, triggerToday);
    dueRoutines.push({ routine, reason });
  }

  return dueRoutines;
}

function isDailyWeekdayRoutine(routine: Routine): boolean {
  const name = routine.name.toLowerCase();
  return (
    name.includes("morning") ||
    name.includes("evening") ||
    name.includes("kickoff") ||
    name.includes("wind-down") ||
    name.includes("wind down")
  );
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function buildDueReason(routine: Routine, triggerTime: Date): string {
  const timeStr = triggerTime.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });

  if (routine.frequency === "weekly") {
    return `Weekly "${routine.name}" is due (trigger: ${timeStr})`;
  }

  return `"${routine.name}" is due (trigger: ${timeStr})`;
}

export class RoutineDueEvaluator {
  private routines: Routine[] = [];

  loadRoutines(markdownContent: string): void {
    this.routines = parseRoutines(markdownContent);
  }

  getRoutines(): Routine[] {
    return [...this.routines];
  }

  evaluateDue(now: Date, lastHeartbeat?: Date): DueRoutine[] {
    return evaluateDue(this.routines, now, lastHeartbeat);
  }
}
