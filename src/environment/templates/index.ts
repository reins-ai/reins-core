import type { PersonalityPreset } from "../../onboarding/types";
import { generatePersonalityMarkdown, PERSONALITY_TEMPLATE } from "./personality.md";
import { USER_TEMPLATE } from "./user.md";
import { HEARTBEAT_TEMPLATE } from "./heartbeat.md";
import { ROUTINES_TEMPLATE } from "./routines.md";
import { GOALS_TEMPLATE } from "./goals.md";
import { KNOWLEDGE_TEMPLATE } from "./knowledge.md";
import { TOOLS_TEMPLATE, STRUCTURED_EXTRACTION_EXAMPLES } from "./tools.md";
import { BOUNDARIES_TEMPLATE } from "./boundaries.md";
import { generateDefaultPersonaYaml } from "../persona";

export const PERSONA_YAML_DEFAULT = generateDefaultPersonaYaml();

/**
 * Document types that must exist in every environment.
 */
export const REQUIRED_DOCUMENTS = [
  "PERSONA.yaml",
  "PERSONALITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "ROUTINES.md",
  "GOALS.md",
  "KNOWLEDGE.md",
  "TOOLS.md",
  "BOUNDARIES.md",
] as const;

export type DocumentName = (typeof REQUIRED_DOCUMENTS)[number];

/**
 * Mapping of document names to their template content.
 */
export const TEMPLATES: Record<DocumentName, string> = {
  "PERSONA.yaml": PERSONA_YAML_DEFAULT,
  "PERSONALITY.md": PERSONALITY_TEMPLATE,
  "USER.md": USER_TEMPLATE,
  "HEARTBEAT.md": HEARTBEAT_TEMPLATE,
  "ROUTINES.md": ROUTINES_TEMPLATE,
  "GOALS.md": GOALS_TEMPLATE,
  "KNOWLEDGE.md": KNOWLEDGE_TEMPLATE,
  "TOOLS.md": TOOLS_TEMPLATE,
  "BOUNDARIES.md": BOUNDARIES_TEMPLATE,
};

/**
 * Get the template content for a specific document.
 *
 * @param docName - The name of the document (e.g., "PERSONALITY.md")
 * @returns The template content as a string
 * @throws Error if the document name is not recognized
 */
export function getTemplate(docName: string): string {
  if (!isDocumentName(docName)) {
    throw new Error(
      `Unknown document name: ${docName}. Valid names are: ${REQUIRED_DOCUMENTS.join(", ")}`
    );
  }
  return TEMPLATES[docName];
}

/**
 * Type guard to check if a string is a valid document name.
 */
function isDocumentName(name: string): name is DocumentName {
  return REQUIRED_DOCUMENTS.includes(name as DocumentName);
}

/**
 * Options for customizing template generation.
 */
export interface TemplateOptions {
  /** Personality preset to use for PERSONALITY.md generation. */
  personalityPreset?: PersonalityPreset;
  /** Custom instructions for the "custom" personality preset. */
  customInstructions?: string;
}

/**
 * Get all template entries as an array of [name, content] tuples.
 *
 * When a `personalityPreset` is provided, PERSONALITY.md is generated
 * using `generatePersonalityMarkdown()` instead of the static template.
 */
export function getAllTemplates(options?: TemplateOptions): Array<[DocumentName, string]> {
  return REQUIRED_DOCUMENTS.map((name) => {
    if (name === "PERSONALITY.md" && options?.personalityPreset) {
      return [name, generatePersonalityMarkdown(options.personalityPreset, options.customInstructions)];
    }
    return [name, TEMPLATES[name]];
  });
}

// Re-export individual templates for direct access
export {
  PERSONALITY_TEMPLATE,
  USER_TEMPLATE,
  HEARTBEAT_TEMPLATE,
  ROUTINES_TEMPLATE,
  GOALS_TEMPLATE,
  KNOWLEDGE_TEMPLATE,
  TOOLS_TEMPLATE,
  STRUCTURED_EXTRACTION_EXAMPLES,
  BOUNDARIES_TEMPLATE,
};

// Re-export personality generation utilities
export { generatePersonalityMarkdown } from "./personality.md";
export type { PersonalityContent } from "./personality.md";
