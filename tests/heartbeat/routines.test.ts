import { describe, expect, test } from "bun:test";

import {
  parseRoutines,
  evaluateDue,
  RoutineDueEvaluator,
  type Routine,
} from "../../src/heartbeat/routines";
import {
  parseGoals,
  generateWeeklyReviewSummary,
  GoalSummaryExtractor,
} from "../../src/heartbeat/goals";
import { ROUTINES_TEMPLATE } from "../../src/environment/templates/routines.md";
import { GOALS_TEMPLATE } from "../../src/environment/templates/goals.md";

describe("parseRoutines", () => {
  test("parses default ROUTINES.md template into structured routines", () => {
    const routines = parseRoutines(ROUTINES_TEMPLATE);

    expect(routines.length).toBe(3);

    const names = routines.map((r) => r.name);
    expect(names).toContain("Morning Kickoff");
    expect(names).toContain("Evening Wind-Down");
    expect(names).toContain("Weekly Review");
  });

  test("parses morning routine trigger time and frequency", () => {
    const routines = parseRoutines(ROUTINES_TEMPLATE);
    const morning = routines.find((r) => r.name === "Morning Kickoff");

    expect(morning).toBeDefined();
    expect(morning!.triggerTime).toBe("7:00 AM");
    expect(morning!.frequency).toBe("daily");
  });

  test("parses evening routine trigger time and frequency", () => {
    const routines = parseRoutines(ROUTINES_TEMPLATE);
    const evening = routines.find((r) => r.name === "Evening Wind-Down");

    expect(evening).toBeDefined();
    expect(evening!.triggerTime).toBe("6:00 PM");
    expect(evening!.frequency).toBe("daily");
  });

  test("parses weekly review with day of week", () => {
    const routines = parseRoutines(ROUTINES_TEMPLATE);
    const weekly = routines.find((r) => r.name === "Weekly Review");

    expect(weekly).toBeDefined();
    expect(weekly!.triggerTime).toBe("5:00 PM");
    expect(weekly!.frequency).toBe("weekly");
    expect(weekly!.dayOfWeek).toBe(0); // Sunday
  });

  test("parses output contract items", () => {
    const routines = parseRoutines(ROUTINES_TEMPLATE);
    const morning = routines.find((r) => r.name === "Morning Kickoff");

    expect(morning!.outputContract.length).toBeGreaterThanOrEqual(3);
    expect(morning!.outputContract[0]).toContain("calendar");
  });

  test("parses action items", () => {
    const routines = parseRoutines(ROUTINES_TEMPLATE);
    const morning = routines.find((r) => r.name === "Morning Kickoff");

    expect(morning!.actions.length).toBeGreaterThanOrEqual(3);
    expect(morning!.actions[0]).toContain("calendar");
  });

  test("skips commented-out template sections", () => {
    const routines = parseRoutines(ROUTINES_TEMPLATE);
    const names = routines.map((r) => r.name);

    expect(names).not.toContain("[Routine Name]");
    expect(names).not.toContain("Custom Routine Template");
  });

  test("returns empty array for empty content", () => {
    expect(parseRoutines("")).toEqual([]);
  });

  test("returns empty array for content without valid routines", () => {
    const content = `# ROUTINES\n\n## Notes\n\nSome notes here.`;
    expect(parseRoutines(content)).toEqual([]);
  });

  test("parses custom routine with non-standard trigger", () => {
    const content = `# ROUTINES

## Daily Standup

**Trigger:** First heartbeat after 9:00 AM

**Output Contract:**
- Team status summary
- Blockers list

**Actions:**
1. Check team calendar
2. Review open tasks
`;

    const routines = parseRoutines(content);
    expect(routines.length).toBe(1);
    expect(routines[0].name).toBe("Daily Standup");
    expect(routines[0].triggerTime).toBe("9:00 AM");
    expect(routines[0].frequency).toBe("daily");
  });
});

describe("evaluateDue", () => {
  const morningRoutine: Routine = {
    name: "Morning Kickoff",
    triggerTime: "7:00 AM",
    frequency: "daily",
    outputContract: ["Calendar summary"],
    actions: ["Check calendar"],
  };

  const eveningRoutine: Routine = {
    name: "Evening Wind-Down",
    triggerTime: "6:00 PM",
    frequency: "daily",
    outputContract: ["Day summary"],
    actions: ["Review day"],
  };

  const weeklyReview: Routine = {
    name: "Weekly Review",
    triggerTime: "5:00 PM",
    frequency: "weekly",
    dayOfWeek: 0, // Sunday
    outputContract: ["Week summary"],
    actions: ["Review goals"],
  };

  test("morning routine is due after trigger time with no prior heartbeat", () => {
    // Wednesday 8:00 AM
    const now = new Date(2026, 1, 11, 8, 0, 0);
    const due = evaluateDue([morningRoutine], now);

    expect(due.length).toBe(1);
    expect(due[0].routine.name).toBe("Morning Kickoff");
    expect(due[0].reason).toContain("Morning Kickoff");
  });

  test("morning routine is not due before trigger time", () => {
    // Wednesday 6:30 AM
    const now = new Date(2026, 1, 11, 6, 30, 0);
    const due = evaluateDue([morningRoutine], now);

    expect(due.length).toBe(0);
  });

  test("morning routine is not due if already triggered today", () => {
    // Wednesday 9:00 AM, last heartbeat at 7:30 AM same day
    const now = new Date(2026, 1, 11, 9, 0, 0);
    const lastHeartbeat = new Date(2026, 1, 11, 7, 30, 0);
    const due = evaluateDue([morningRoutine], now, lastHeartbeat);

    expect(due.length).toBe(0);
  });

  test("morning routine is due when last heartbeat was before trigger time today", () => {
    // Wednesday 7:30 AM, last heartbeat at 6:45 AM same day
    const now = new Date(2026, 1, 11, 7, 30, 0);
    const lastHeartbeat = new Date(2026, 1, 11, 6, 45, 0);
    const due = evaluateDue([morningRoutine], now, lastHeartbeat);

    expect(due.length).toBe(1);
    expect(due[0].routine.name).toBe("Morning Kickoff");
  });

  test("morning routine is due when last heartbeat was yesterday", () => {
    // Wednesday 8:00 AM, last heartbeat was Tuesday 10:00 PM
    const now = new Date(2026, 1, 11, 8, 0, 0);
    const lastHeartbeat = new Date(2026, 1, 10, 22, 0, 0);
    const due = evaluateDue([morningRoutine], now, lastHeartbeat);

    expect(due.length).toBe(1);
  });

  test("morning routine is not due on weekends", () => {
    // Saturday 8:00 AM
    const now = new Date(2026, 1, 14, 8, 0, 0);
    const due = evaluateDue([morningRoutine], now);

    expect(due.length).toBe(0);
  });

  test("evening routine is not due on weekends", () => {
    // Sunday 7:00 PM
    const now = new Date(2026, 1, 15, 19, 0, 0);
    const due = evaluateDue([eveningRoutine], now);

    expect(due.length).toBe(0);
  });

  test("weekly review is due on correct day after trigger time", () => {
    // Sunday 5:30 PM
    const now = new Date(2026, 1, 15, 17, 30, 0);
    const due = evaluateDue([weeklyReview], now);

    expect(due.length).toBe(1);
    expect(due[0].routine.name).toBe("Weekly Review");
    expect(due[0].reason).toContain("Weekly");
  });

  test("weekly review is not due on wrong day", () => {
    // Wednesday 5:30 PM
    const now = new Date(2026, 1, 11, 17, 30, 0);
    const due = evaluateDue([weeklyReview], now);

    expect(due.length).toBe(0);
  });

  test("weekly review is not due before trigger time on correct day", () => {
    // Sunday 4:00 PM
    const now = new Date(2026, 1, 15, 16, 0, 0);
    const due = evaluateDue([weeklyReview], now);

    expect(due.length).toBe(0);
  });

  test("weekly review is not due if already triggered today", () => {
    // Sunday 6:00 PM, last heartbeat at 5:15 PM same day
    const now = new Date(2026, 1, 15, 18, 0, 0);
    const lastHeartbeat = new Date(2026, 1, 15, 17, 15, 0);
    const due = evaluateDue([weeklyReview], now, lastHeartbeat);

    expect(due.length).toBe(0);
  });

  test("evaluates multiple routines simultaneously", () => {
    // Wednesday 7:30 PM — both morning and evening should be due (no prior heartbeat)
    const now = new Date(2026, 1, 11, 19, 30, 0);
    const due = evaluateDue([morningRoutine, eveningRoutine, weeklyReview], now);

    expect(due.length).toBe(2);
    const names = due.map((d) => d.routine.name);
    expect(names).toContain("Morning Kickoff");
    expect(names).toContain("Evening Wind-Down");
    expect(names).not.toContain("Weekly Review");
  });

  test("returns empty array when no routines are due", () => {
    // Wednesday 5:00 AM — too early for anything
    const now = new Date(2026, 1, 11, 5, 0, 0);
    const due = evaluateDue([morningRoutine, eveningRoutine, weeklyReview], now);

    expect(due.length).toBe(0);
  });

  test("handles exact trigger time boundary", () => {
    // Wednesday exactly 7:00 AM
    const now = new Date(2026, 1, 11, 7, 0, 0);
    const due = evaluateDue([morningRoutine], now);

    expect(due.length).toBe(1);
  });
});

describe("RoutineDueEvaluator", () => {
  test("loads routines from markdown and evaluates due items", () => {
    const evaluator = new RoutineDueEvaluator();
    evaluator.loadRoutines(ROUTINES_TEMPLATE);

    expect(evaluator.getRoutines().length).toBe(3);

    // Wednesday 8:00 AM — morning should be due
    const now = new Date(2026, 1, 11, 8, 0, 0);
    const due = evaluator.evaluateDue(now);

    expect(due.length).toBe(1);
    expect(due[0].routine.name).toBe("Morning Kickoff");
  });

  test("returns defensive copy of routines", () => {
    const evaluator = new RoutineDueEvaluator();
    evaluator.loadRoutines(ROUTINES_TEMPLATE);

    const routines1 = evaluator.getRoutines();
    const routines2 = evaluator.getRoutines();

    expect(routines1).not.toBe(routines2);
    expect(routines1).toEqual(routines2);
  });
});

describe("parseGoals", () => {
  test("parses default GOALS.md template into structured goals", () => {
    const goals = parseGoals(GOALS_TEMPLATE);

    expect(goals.length).toBeGreaterThanOrEqual(4);

    const titles = goals.map((g) => g.title);
    expect(titles).toContain("Launch New Feature (Q1 2026)");
    expect(titles).toContain("Read 2 Books Per Month");
    expect(titles).toContain("Improve Fitness Consistency");
    expect(titles).toContain("Learn Spanish");
    expect(titles).toContain("Migrate to New Task System");
  });

  test("parses active goal fields correctly", () => {
    const goals = parseGoals(GOALS_TEMPLATE);
    const launch = goals.find((g) => g.title === "Launch New Feature (Q1 2026)");

    expect(launch).toBeDefined();
    expect(launch!.state).toBe("active");
    expect(launch!.target).toContain("Ship user authentication");
    expect(launch!.progress).toContain("75%");
    expect(launch!.trackingMethod).toContain("Milestone");
  });

  test("parses paused goal state", () => {
    const goals = parseGoals(GOALS_TEMPLATE);
    const spanish = goals.find((g) => g.title === "Learn Spanish");

    expect(spanish).toBeDefined();
    expect(spanish!.state).toBe("paused");
    expect(spanish!.progress).toContain("A2");
  });

  test("parses completed goal state", () => {
    const goals = parseGoals(GOALS_TEMPLATE);
    const migrate = goals.find((g) => g.title === "Migrate to New Task System");

    expect(migrate).toBeDefined();
    expect(migrate!.state).toBe("completed");
  });

  test("parses assistant role as joined string", () => {
    const goals = parseGoals(GOALS_TEMPLATE);
    const launch = goals.find((g) => g.title === "Launch New Feature (Q1 2026)");

    expect(launch!.assistantRole).toContain("Remind about upcoming milestone deadlines");
    expect(launch!.assistantRole).toContain("Surface blockers");
  });

  test("returns empty array for empty content", () => {
    expect(parseGoals("")).toEqual([]);
  });

  test("skips commented-out template sections", () => {
    const goals = parseGoals(GOALS_TEMPLATE);
    const titles = goals.map((g) => g.title);

    expect(titles).not.toContain("[Goal Name]");
    expect(titles).not.toContain("Goal Template");
  });
});

describe("generateWeeklyReviewSummary", () => {
  test("generates summary with active, completed, and paused goals", () => {
    const goals = parseGoals(GOALS_TEMPLATE);
    const summary = generateWeeklyReviewSummary(goals);

    expect(summary).toContain("Goal Progress Summary");
    expect(summary).toContain("Active Goals");
    expect(summary).toContain("Launch New Feature");
    expect(summary).toContain("Completed Goals");
    expect(summary).toContain("Paused Goals");
    expect(summary).toContain("Learn Spanish");
  });

  test("includes progress for active goals", () => {
    const goals = parseGoals(GOALS_TEMPLATE);
    const summary = generateWeeklyReviewSummary(goals);

    expect(summary).toContain("75%");
  });

  test("handles empty goals list", () => {
    const summary = generateWeeklyReviewSummary([]);

    expect(summary).toContain("No goals defined");
  });

  test("handles only active goals", () => {
    const goals = [
      {
        title: "Test Goal",
        state: "active" as const,
        target: "Do something",
        progress: "50%",
        trackingMethod: "Manual",
        assistantRole: "Track progress",
      },
    ];

    const summary = generateWeeklyReviewSummary(goals);

    expect(summary).toContain("Active Goals");
    expect(summary).toContain("Test Goal");
    expect(summary).toContain("50%");
    expect(summary).not.toContain("Completed Goals");
    expect(summary).not.toContain("Paused Goals");
  });
});

describe("GoalSummaryExtractor", () => {
  test("loads goals and provides filtered access", () => {
    const extractor = new GoalSummaryExtractor();
    extractor.loadGoals(GOALS_TEMPLATE);

    expect(extractor.getGoals().length).toBeGreaterThanOrEqual(4);
    expect(extractor.getActiveGoals().length).toBeGreaterThanOrEqual(3);
    expect(extractor.getPausedGoals().length).toBeGreaterThanOrEqual(1);
    expect(extractor.getCompletedGoals().length).toBeGreaterThanOrEqual(1);
  });

  test("generates weekly review summary from loaded goals", () => {
    const extractor = new GoalSummaryExtractor();
    extractor.loadGoals(GOALS_TEMPLATE);

    const summary = extractor.generateWeeklyReviewSummary();
    expect(summary).toContain("Goal Progress Summary");
    expect(summary).toContain("Active Goals");
  });

  test("returns defensive copy of goals", () => {
    const extractor = new GoalSummaryExtractor();
    extractor.loadGoals(GOALS_TEMPLATE);

    const goals1 = extractor.getGoals();
    const goals2 = extractor.getGoals();

    expect(goals1).not.toBe(goals2);
    expect(goals1).toEqual(goals2);
  });
});
