import type { DueRoutine } from "./routines";
import { RoutineDueEvaluator } from "./routines";

export interface SkipEvaluationContext {
  heartbeatContent?: string;
  routinesContent?: string;
  goalsContent?: string;
  now: Date;
  lastHeartbeat?: Date;
}

export interface SkipDecision {
  skip: boolean;
  reason: string;
  dueRoutines: DueRoutine[];
  metrics: {
    evaluationTimeMs: number;
  };
}

const CHECK_ITEM_HEADING_REGEX = /^##\s+check items\s*$/i;
const CHECK_ITEM_ENTRY_REGEX = /^(?:\d+\.\s+|-\s+)/;

export class HeartbeatSkipEvaluator {
  constructor(private readonly routineDueEvaluator: RoutineDueEvaluator) {}

  shouldSkip(context: SkipEvaluationContext): SkipDecision {
    const startedAt = Date.now();

    const finish = (decision: Omit<SkipDecision, "metrics">): SkipDecision => {
      const endedAt = Date.now();
      return {
        ...decision,
        metrics: {
          evaluationTimeMs: Math.max(0, endedAt - startedAt),
        },
      };
    };

    if (!context.routinesContent) {
      return finish({
        skip: false,
        reason: "execute.insufficient_context.missing_routines",
        dueRoutines: [],
      });
    }

    this.routineDueEvaluator.loadRoutines(context.routinesContent);
    const dueRoutines = this.routineDueEvaluator.evaluateDue(context.now, context.lastHeartbeat);

    if (dueRoutines.length > 0) {
      return finish({
        skip: false,
        reason: "execute.routines_due",
        dueRoutines,
      });
    }

    const hasHeartbeatChecks = detectHeartbeatChecks(context.heartbeatContent);
    if (hasHeartbeatChecks === "unknown") {
      return finish({
        skip: false,
        reason: "execute.insufficient_context.heartbeat_unknown",
        dueRoutines,
      });
    }

    if (hasHeartbeatChecks) {
      return finish({
        skip: false,
        reason: "execute.heartbeat_checks_configured",
        dueRoutines,
      });
    }

    return finish({
      skip: true,
      reason: "skip.no_due_routines_and_no_heartbeat_checks",
      dueRoutines,
    });
  }
}

function detectHeartbeatChecks(content?: string): boolean | "unknown" {
  if (content === undefined) {
    return "unknown";
  }

  const lines = content.split("\n");
  let inCheckItems = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (CHECK_ITEM_HEADING_REGEX.test(trimmed)) {
      inCheckItems = true;
      continue;
    }

    if (inCheckItems && /^##\s+/.test(trimmed)) {
      break;
    }

    if (inCheckItems && CHECK_ITEM_ENTRY_REGEX.test(trimmed)) {
      return true;
    }
  }

  return false;
}
