import type { ThinkingLevel } from "../../types/provider";

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
