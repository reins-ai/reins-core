import { describe, expect, test } from "bun:test";

import { HEARTBEAT_TEMPLATE } from "../../src/environment/templates/heartbeat.md";
import { ROUTINES_TEMPLATE } from "../../src/environment/templates/routines.md";
import { RoutineDueEvaluator } from "../../src/heartbeat/routines";
import { HeartbeatSkipEvaluator } from "../../src/heartbeat/skip-evaluator";

function createEvaluator(): HeartbeatSkipEvaluator {
  return new HeartbeatSkipEvaluator(new RoutineDueEvaluator());
}

describe("HeartbeatSkipEvaluator", () => {
  test("skips when no routines are due and no heartbeat checks are configured", () => {
    const evaluator = createEvaluator();

    const decision = evaluator.shouldSkip({
      now: new Date(2026, 1, 11, 5, 0, 0),
      routinesContent: ROUTINES_TEMPLATE,
      heartbeatContent: "# HEARTBEAT\n\n## Check Items\n",
    });

    expect(decision.skip).toBe(true);
    expect(decision.reason).toBe("skip.no_due_routines_and_no_heartbeat_checks");
    expect(decision.dueRoutines).toHaveLength(0);
  });

  test("does not skip when morning routine is due", () => {
    const evaluator = createEvaluator();

    const decision = evaluator.shouldSkip({
      now: new Date(2026, 1, 11, 8, 0, 0),
      routinesContent: ROUTINES_TEMPLATE,
      heartbeatContent: "# HEARTBEAT\n\n## Check Items\n",
    });

    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("execute.routines_due");
    expect(decision.dueRoutines.some((due) => due.routine.name === "Morning Kickoff")).toBe(true);
  });

  test("does not skip when weekly review routine is due", () => {
    const evaluator = createEvaluator();

    const decision = evaluator.shouldSkip({
      now: new Date(2026, 1, 15, 17, 30, 0),
      routinesContent: ROUTINES_TEMPLATE,
      heartbeatContent: "# HEARTBEAT\n\n## Check Items\n",
    });

    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("execute.routines_due");
    expect(decision.dueRoutines.some((due) => due.routine.name === "Weekly Review")).toBe(true);
  });

  test("does not skip when heartbeat document has explicit checks", () => {
    const evaluator = createEvaluator();

    const decision = evaluator.shouldSkip({
      now: new Date(2026, 1, 11, 5, 0, 0),
      routinesContent: ROUTINES_TEMPLATE,
      heartbeatContent: HEARTBEAT_TEMPLATE,
    });

    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("execute.heartbeat_checks_configured");
  });

  test("returns evaluation metrics with elapsed time", () => {
    const evaluator = createEvaluator();

    const decision = evaluator.shouldSkip({
      now: new Date(2026, 1, 11, 5, 0, 0),
      routinesContent: ROUTINES_TEMPLATE,
      heartbeatContent: "# HEARTBEAT\n\n## Check Items\n",
    });

    expect(Number.isFinite(decision.metrics.evaluationTimeMs)).toBe(true);
    expect(decision.metrics.evaluationTimeMs).toBeGreaterThanOrEqual(0);
  });

  test("uses conservative behavior and does not skip when context is incomplete", () => {
    const evaluator = createEvaluator();

    const decision = evaluator.shouldSkip({
      now: new Date(2026, 1, 11, 5, 0, 0),
      heartbeatContent: "# HEARTBEAT\n\n## Check Items\n",
    });

    expect(decision.skip).toBe(false);
    expect(decision.reason).toBe("execute.insufficient_context.missing_routines");
  });
});
