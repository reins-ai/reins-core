import type { SkillSummary } from "./types";

const SKILL_PREAMBLE = `## Available Skills

You have access to the following skills. To load a skill's full content and instructions, use the \`load_skill\` tool with the skill name.`;

/**
 * Format a token-efficient skill index for system prompt injection.
 * Returns empty string if no summaries provided.
 */
export function formatSkillIndex(summaries: SkillSummary[]): string {
  if (summaries.length === 0) {
    return "";
  }

  const entries = summaries
    .map((s) => `- **${s.name}**: ${s.description}`)
    .join("\n");

  return `${SKILL_PREAMBLE}\n\n${entries}`;
}

/**
 * Estimate token count for a skill index.
 * Uses characters / 4 heuristic (reasonable for English text).
 */
export function getSkillIndexTokenEstimate(summaries: SkillSummary[]): number {
  const formatted = formatSkillIndex(summaries);
  return Math.ceil(formatted.length / 4);
}
