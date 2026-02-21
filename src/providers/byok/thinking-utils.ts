import type { ThinkingLevel } from "../../types/provider";

/**
 * Token budgets for each thinking level.
 * These are capped by the model's maxTokens at call time via `thinkingLevelToBudget`.
 * - low: 1 024 tokens — quick reasoning for simple tasks
 * - medium: 4 096 tokens — balanced reasoning for moderate complexity
 * - high: 10 240 tokens — deep reasoning for complex multi-step problems
 */
const THINKING_BUDGETS: Record<Exclude<ThinkingLevel, "none">, number> = {
  low: 1024,
  medium: 4096,
  high: 10240,
};

export function thinkingLevelToBudget(
  level: ThinkingLevel,
  maxTokens: number,
): number | undefined {
  if (level === "none") {
    return undefined;
  }

  return Math.min(THINKING_BUDGETS[level], maxTokens - 1);
}
