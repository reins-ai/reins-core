import { err, ok, type Result } from "../result";
import type { EnvironmentError } from "./errors";
import { EnvironmentScopeViolationError } from "./errors";
import { isGlobalSetting } from "./scope";

export type BoundarySection = "canDo" | "willNotDo" | "grayArea";

export interface BoundaryItem {
  section: BoundarySection;
  text: string;
}

export interface BoundariesPolicy {
  canDo: string[];
  willNotDo: string[];
  grayArea: string[];
  items?: BoundaryItem[];
  environmentName: string;
  raw: string;
}

/**
 * Parse a BOUNDARIES.md document into a typed BoundariesPolicy scoped to
 * an environment.
 *
 * Extracts three sections: Can Do, Will Not Do, and Gray Area.
 * Each section contains checklist items (✅, ❌, ⚠️ prefixed list items).
 */
export function parseBoundariesPolicy(
  markdown: string,
  environmentName?: string,
): BoundariesPolicy {
  const sections = splitSections(markdown);

  return {
    canDo: extractChecklistItems(sections, "can do"),
    willNotDo: extractChecklistItems(sections, "will not do"),
    grayArea: extractChecklistItems(sections, "gray area"),
    items: undefined,
    environmentName: environmentName ?? "",
    raw: markdown,
  };
}

/**
 * Build a default BoundariesPolicy when no BOUNDARIES.md is available.
 */
export function defaultBoundariesPolicy(environmentName: string): BoundariesPolicy {
  return {
    canDo: [],
    willNotDo: [],
    grayArea: [],
    environmentName,
    raw: "",
  };
}

/**
 * Check whether a request description matches any "will not do" boundary.
 * Uses case-insensitive normalized substring matching.
 */
export function isProhibited(policy: BoundariesPolicy, request: string): boolean {
  if (policy.willNotDo.length === 0) {
    return false;
  }

  const normalizedRequest = normalizeText(request);
  if (normalizedRequest.length === 0) {
    return false;
  }

  return policy.willNotDo.some(
    (rule) => normalizedRequest.includes(normalizeText(rule)),
  );
}

/**
 * Check whether a request description falls in the gray area.
 * Uses case-insensitive normalized substring matching.
 */
export function isGrayArea(policy: BoundariesPolicy, request: string): boolean {
  if (policy.grayArea.length === 0) {
    return false;
  }

  const normalizedRequest = normalizeText(request);
  if (normalizedRequest.length === 0) {
    return false;
  }

  return policy.grayArea.some(
    (rule) => normalizedRequest.includes(normalizeText(rule)),
  );
}

/**
 * Validate that a BoundariesPolicy is internally consistent and properly scoped.
 */
export function validateBoundariesPolicy(
  policy: BoundariesPolicy,
): Result<void, EnvironmentError> {
  // Items must not appear in both can-do and will-not-do
  const canDoNormalized = new Set(policy.canDo.map(normalizeText));
  for (const item of policy.willNotDo) {
    if (canDoNormalized.has(normalizeText(item))) {
      return err(
        new EnvironmentScopeViolationError(
          `Boundary conflict: "${item}" appears in both Can Do and Will Not Do`,
        ),
      );
    }
  }

  // Boundaries policy must not be stored in global scope
  if (isGlobalSetting("BOUNDARIES")) {
    return err(
      new EnvironmentScopeViolationError(
        "BOUNDARIES policy must remain environment-scoped, not global",
      ),
    );
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Internal parsing helpers
// ---------------------------------------------------------------------------

function splitSections(markdown: string): Array<{ heading: string; content: string }> {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  if (matches.length === 0) {
    return [];
  }

  const sections: Array<{ heading: string; content: string }> = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const heading = normalizeHeading(match[1] ?? "");
    const start = (match.index ?? 0) + match[0].length;
    const nextStart = matches[index + 1]?.index ?? markdown.length;
    const content = markdown.slice(start, nextStart);

    sections.push({ heading, content });
  }

  return sections;
}

function extractChecklistItems(
  sections: Array<{ heading: string; content: string }>,
  sectionName: "can do" | "will not do" | "gray area",
): string[] {
  const section = sections.find((candidate) => candidate.heading.includes(sectionName));
  if (!section) {
    return [];
  }

  const items: string[] = [];
  const lines = section.content.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    const bullet = trimmed.match(/^[-*]\s+(?:[^a-zA-Z0-9]+\s*)?(.+)$/);
    if (!bullet) {
      continue;
    }

    const item = bullet[1]?.trim();
    if (!item) {
      continue;
    }

    items.push(item);
  }

  return items;
}

function normalizeHeading(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ");
}
