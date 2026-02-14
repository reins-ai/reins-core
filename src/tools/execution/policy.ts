import type { BoundariesPolicy } from "../../environment/boundaries-policy";
import type { AggressivenessLevel, ToolsPolicy } from "../../environment/tools-policy";

const DEFAULT_AGGRESSIVENESS: AggressivenessLevel = "medium";
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "any",
  "for",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "without",
]);

export class ToolExecutionPolicy {
  constructor(
    private readonly toolsPolicy: ToolsPolicy,
    private readonly boundariesPolicy?: BoundariesPolicy,
  ) {}

  isToolAllowed(toolName: string): boolean {
    const normalizedToolName = normalizeToken(toolName);
    if (normalizedToolName.length === 0) {
      return false;
    }

    if (this.toolsPolicy.disabled.includes(normalizedToolName)) {
      return false;
    }

    if (this.toolsPolicy.enabled.length === 0) {
      return true;
    }

    return this.toolsPolicy.enabled.includes(normalizedToolName);
  }

  getAggressiveness(toolCategory: string): AggressivenessLevel {
    const normalizedCategory = normalizeToken(toolCategory);
    if (normalizedCategory.length === 0) {
      return this.toolsPolicy.aggressiveness.default ?? DEFAULT_AGGRESSIVENESS;
    }

    return (
      this.toolsPolicy.aggressiveness[normalizedCategory] ??
      this.toolsPolicy.aggressiveness.default ??
      DEFAULT_AGGRESSIVENESS
    );
  }

  shouldDeclineRequest(userRequest: string): boolean {
    const boundaries = this.boundariesPolicy?.willNotDo;
    if (!boundaries || boundaries.length === 0) {
      return false;
    }

    const normalizedRequest = normalizeText(userRequest);
    if (normalizedRequest.length === 0) {
      return false;
    }

    return boundaries.some((rule) => this.matchesBoundaryRule(normalizedRequest, rule));
  }

  getReminderFollowUpMode(): "none" | "gentle" | "persistent" {
    const level = this.getAggressiveness("reminders");
    if (level === "low") {
      return "none";
    }

    if (level === "medium") {
      return "gentle";
    }

    return "persistent";
  }

  private matchesBoundaryRule(normalizedRequest: string, rule: string): boolean {
    const normalizedRule = normalizeText(rule);
    if (normalizedRule.length === 0) {
      return false;
    }

    if (normalizedRequest.includes(normalizedRule)) {
      return true;
    }

    const requestWords = new Set(normalizedRequest.split(" "));
    const significantRuleWords = normalizedRule
      .split(" ")
      .filter((word) => word.length > 3)
      .filter((word) => !STOP_WORDS.has(word));

    if (significantRuleWords.length === 0) {
      return false;
    }

    let matchedWords = 0;
    for (const word of significantRuleWords) {
      if (requestWords.has(word)) {
        matchedWords += 1;
      }
    }

    return matchedWords >= Math.min(2, significantRuleWords.length);
  }
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ");
}
