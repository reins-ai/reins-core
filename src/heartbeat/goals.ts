/**
 * Goal summary extraction for weekly review integration.
 *
 * Parses GOALS.md into structured goal objects and generates
 * weekly review summaries for the heartbeat routine pipeline.
 */

export type GoalState = "active" | "completed" | "paused";

export interface Goal {
  title: string;
  state: GoalState;
  target: string;
  progress: string;
  trackingMethod: string;
  assistantRole: string;
}

const VALID_STATES: GoalState[] = ["active", "completed", "paused"];

/**
 * Parse GOALS.md markdown content into structured Goal objects.
 *
 * Expects H3 sections under H2 category headings (Active Goals, Paused Goals, Completed Goals)
 * with **State:**, **Target:**, **Progress:**, **Tracking Method:**, and **Assistant Role:** fields.
 */
export function parseGoals(markdownContent: string): Goal[] {
  const goals: Goal[] = [];
  const lines = markdownContent.split("\n");

  let currentTitle: string | null = null;
  let state: GoalState = "active";
  let target = "";
  let progress = "";
  let trackingMethod = "";
  let assistantRole: string[] = [];
  let inAssistantRole = false;
  let inComment = false;
  let sectionState: GoalState | null = null;

  const flushGoal = () => {
    if (!currentTitle) {
      return;
    }

    goals.push({
      title: currentTitle,
      state,
      target,
      progress,
      trackingMethod,
      assistantRole: assistantRole.join("; "),
    });

    currentTitle = null;
    state = sectionState ?? "active";
    target = "";
    progress = "";
    trackingMethod = "";
    assistantRole = [];
    inAssistantRole = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("<!--")) {
      inComment = true;
      if (trimmed.endsWith("-->")) {
        inComment = false;
      }
      continue;
    }
    if (inComment) {
      if (trimmed.endsWith("-->")) {
        inComment = false;
      }
      continue;
    }

    if (trimmed.startsWith("## ") && !trimmed.startsWith("### ")) {
      flushGoal();

      const heading = trimmed.replace(/^##\s+/, "").trim().toLowerCase();
      if (heading.includes("active")) {
        sectionState = "active";
      } else if (heading.includes("paused")) {
        sectionState = "paused";
      } else if (heading.includes("completed")) {
        sectionState = "completed";
      } else {
        sectionState = null;
      }
      state = sectionState ?? "active";
      continue;
    }

    if (trimmed.startsWith("### ")) {
      flushGoal();

      const heading = trimmed.replace(/^###\s+/, "").trim();
      const skipHeadings = ["goal template"];
      if (skipHeadings.some((s) => heading.toLowerCase().startsWith(s))) {
        currentTitle = null;
        continue;
      }

      currentTitle = heading;
      state = sectionState ?? "active";
      inAssistantRole = false;
      continue;
    }

    if (!currentTitle) {
      continue;
    }

    if (trimmed.startsWith("**State:**")) {
      const rawState = trimmed.replace("**State:**", "").trim().toLowerCase();
      if (VALID_STATES.includes(rawState as GoalState)) {
        state = rawState as GoalState;
      }
      inAssistantRole = false;
      continue;
    }

    if (trimmed.startsWith("**Target:**")) {
      target = trimmed.replace("**Target:**", "").trim();
      inAssistantRole = false;
      continue;
    }

    if (trimmed.startsWith("**Progress:**")) {
      progress = trimmed.replace("**Progress:**", "").trim();
      inAssistantRole = false;
      continue;
    }

    if (trimmed.startsWith("**Tracking Method:**")) {
      trackingMethod = trimmed.replace("**Tracking Method:**", "").trim();
      inAssistantRole = false;
      continue;
    }

    if (trimmed.startsWith("**Final Progress:**")) {
      progress = trimmed.replace("**Final Progress:**", "").trim();
      inAssistantRole = false;
      continue;
    }

    if (trimmed.startsWith("**Completed:**") && state === "completed") {
      progress = trimmed.replace("**Completed:**", "").trim();
      inAssistantRole = false;
      continue;
    }

    if (trimmed.startsWith("**Assistant Role:**")) {
      inAssistantRole = true;
      continue;
    }

    if (inAssistantRole && trimmed.startsWith("- ")) {
      assistantRole.push(trimmed.replace(/^-\s+/, ""));
      continue;
    }

    if (inAssistantRole && !trimmed.startsWith("- ") && trimmed.length > 0) {
      if (
        trimmed.startsWith("**") ||
        trimmed.startsWith("---") ||
        trimmed.startsWith("##")
      ) {
        inAssistantRole = false;
      }
    }
  }

  flushGoal();

  return goals;
}

/**
 * Generate a weekly review summary from parsed goals.
 *
 * Produces a structured text summary listing:
 * - Active goals with current progress
 * - Recently completed goals
 * - Paused goals with context
 */
export function generateWeeklyReviewSummary(goals: Goal[]): string {
  const active = goals.filter((g) => g.state === "active");
  const completed = goals.filter((g) => g.state === "completed");
  const paused = goals.filter((g) => g.state === "paused");

  const sections: string[] = [];

  sections.push("## Goal Progress Summary");
  sections.push("");

  if (active.length > 0) {
    sections.push("### Active Goals");
    sections.push("");
    for (const goal of active) {
      sections.push(`- **${goal.title}**: ${goal.progress}`);
      if (goal.target) {
        sections.push(`  Target: ${goal.target}`);
      }
    }
    sections.push("");
  }

  if (completed.length > 0) {
    sections.push("### Completed Goals");
    sections.push("");
    for (const goal of completed) {
      sections.push(`- **${goal.title}**: ${goal.progress}`);
    }
    sections.push("");
  }

  if (paused.length > 0) {
    sections.push("### Paused Goals");
    sections.push("");
    for (const goal of paused) {
      sections.push(`- **${goal.title}**: ${goal.progress}`);
    }
    sections.push("");
  }

  if (active.length === 0 && completed.length === 0 && paused.length === 0) {
    sections.push("No goals defined. Consider adding goals to GOALS.md.");
    sections.push("");
  }

  return sections.join("\n").trimEnd();
}

export class GoalSummaryExtractor {
  private goals: Goal[] = [];

  loadGoals(markdownContent: string): void {
    this.goals = parseGoals(markdownContent);
  }

  getGoals(): Goal[] {
    return [...this.goals];
  }

  getActiveGoals(): Goal[] {
    return this.goals.filter((g) => g.state === "active");
  }

  getCompletedGoals(): Goal[] {
    return this.goals.filter((g) => g.state === "completed");
  }

  getPausedGoals(): Goal[] {
    return this.goals.filter((g) => g.state === "paused");
  }

  generateWeeklyReviewSummary(): string {
    return generateWeeklyReviewSummary(this.goals);
  }
}
