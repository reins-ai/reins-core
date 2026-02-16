import { readFile } from "node:fs/promises";

import { SkillError } from "./errors";
import { type Result, err, ok } from "../result";

/**
 * Tracks whether a skill requires integration setup and its current state.
 */
export type IntegrationStatus = "not_required" | "needs_setup" | "setup_complete";

/**
 * A section extracted from an INTEGRATION.md file, split on markdown headings.
 */
export interface IntegrationSection {
  /** Section heading text */
  title: string;
  /** Section content (without the heading line) */
  content: string;
  /** Heading level (1–6) */
  level: number;
}

/**
 * Structured representation of a parsed INTEGRATION.md file.
 */
export interface IntegrationGuide {
  /** Full raw content of INTEGRATION.md */
  content: string;
  /** Extracted sections from markdown headings */
  sections: IntegrationSection[];
  /** Whether the guide contains setup steps (heuristic: numbered lists or setup-related headings) */
  hasSetupSteps: boolean;
}

/** Heading titles that indicate setup instructions are present */
const SETUP_HEADINGS = [
  "setup",
  "installation",
  "getting started",
  "prerequisites",
  "configuration",
];

/**
 * Read and parse an INTEGRATION.md file into structured sections.
 *
 * Returns an `IntegrationGuide` with the raw content, extracted sections,
 * and a heuristic flag indicating whether setup steps are present.
 */
export async function readIntegrationMd(
  filePath: string,
): Promise<Result<IntegrationGuide, SkillError>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(
      new SkillError(`Failed to read INTEGRATION.md at "${filePath}": ${message}`),
    );
  }

  if (content.trim() === "") {
    return err(new SkillError(`INTEGRATION.md is empty at "${filePath}"`));
  }

  const sections = extractSections(content);
  const hasSetupSteps = detectSetupSteps(content, sections);

  return ok({ content, sections, hasSetupSteps });
}

/**
 * Extract sections from markdown content by splitting on heading lines.
 *
 * Each heading (`# … ` through `###### …`) starts a new section.
 * Content before the first heading is ignored (preamble).
 */
function extractSections(content: string): IntegrationSection[] {
  const sections: IntegrationSection[] = [];
  const lines = content.split("\n");
  let currentSection: IntegrationSection | null = null;
  let contentLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (currentSection) {
        currentSection.content = contentLines.join("\n").trim();
        sections.push(currentSection);
      }
      currentSection = {
        title: headingMatch[2].trim(),
        content: "",
        level: headingMatch[1].length,
      };
      contentLines = [];
    } else if (currentSection) {
      contentLines.push(line);
    }
  }

  if (currentSection) {
    currentSection.content = contentLines.join("\n").trim();
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Heuristically detect whether the guide contains setup steps.
 *
 * Returns `true` if any section heading matches a known setup-related title
 * (case-insensitive) or the content contains numbered list items (`1. …`).
 */
function detectSetupSteps(
  content: string,
  sections: IntegrationSection[],
): boolean {
  const hasSetupHeading = sections.some((s) =>
    SETUP_HEADINGS.includes(s.title.toLowerCase()),
  );

  const hasNumberedSteps = /^\d+\.\s/m.test(content);

  return hasSetupHeading || hasNumberedSteps;
}

/**
 * Determine the integration status for a skill based on whether it has an
 * INTEGRATION.md file and whether setup has been completed.
 */
export function getIntegrationStatus(
  hasIntegrationMd: boolean,
  setupComplete?: boolean,
): IntegrationStatus {
  if (!hasIntegrationMd) return "not_required";
  if (setupComplete) return "setup_complete";
  return "needs_setup";
}
