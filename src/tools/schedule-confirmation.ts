import type { NlTimeResult } from "./date-parser";

export function formatScheduleConfirmation(result: NlTimeResult): string {
  const base = result.type === "recurring"
    ? `I'll do this ${result.humanReadable}. Say 'cancel task' to stop it.`
    : formatOnceConfirmation(result);

  if (result.confidence === "low") {
    return `${base} (Note: I interpreted this as '${result.humanReadable}' — let me know if that's wrong.)`;
  }

  return base;
}

function formatOnceConfirmation(result: NlTimeResult): string {
  if (!result.runAt) {
    return `I'll remind you on ${result.humanReadable}.`;
  }

  const label = relativeDayLabel(result.runAt);
  if (label) {
    return `I'll remind you ${label} at ${formatTimeOfDay(result.runAt)}.`;
  }

  return `I'll remind you on ${formatFullDate(result.runAt)}.`;
}

function relativeDayLabel(date: Date): string | null {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const targetStart = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diffDays = Math.round(
    (targetStart.getTime() - todayStart.getTime()) / 86_400_000,
  );

  if (diffDays === 0) {
    return "today";
  }

  if (diffDays === 1) {
    return "tomorrow";
  }

  return null;
}

function formatTimeOfDay(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function formatFullDate(date: Date): string {
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const month = date.toLocaleDateString("en-US", { month: "short" });
  const day = date.getDate();
  const time = formatTimeOfDay(date);

  return `${weekday}, ${month} ${day} at ${time}`;
}
