import { err, ok, type Result } from "../result";
import type { EnvironmentError } from "./errors";
import { EnvironmentScopeViolationError } from "./errors";
import { isGlobalSetting } from "./scope";

export type AggressivenessLevel = "low" | "medium" | "high";
export const AGGRESSIVENESS_LEVELS = ["low", "medium", "high"] as const;

export type ToolStatus = "enabled" | "disabled";
export const TOOL_STATUSES = ["enabled", "disabled"] as const;

export interface ToolPermission {
  description: string;
  allowed: boolean;
}

export interface ToolPreference {
  name: string;
  status: ToolStatus;
  aggressiveness: AggressivenessLevel;
}

export interface ToolsPolicy {
  enabled: string[];
  disabled: string[];
  aggressiveness: Record<string, AggressivenessLevel>;
  tools?: ToolPreference[];
  environmentName: string;
  raw: string;
}

const DEFAULT_AGGRESSIVENESS: AggressivenessLevel = "medium";

const AGGRESSIVENESS_ALIASES: Readonly<Record<string, AggressivenessLevel>> = {
  conservative: "low",
  low: "low",
  moderate: "medium",
  medium: "medium",
  proactive: "high",
  high: "high",
};

/**
 * Parse a TOOLS.md document into a typed ToolsPolicy scoped to an environment.
 *
 * Extracts global aggressiveness, per-tool status (enabled/disabled), and
 * per-tool aggressiveness levels from markdown H3 sections.
 */
export function parseToolsPolicy(
  markdown: string,
  environmentName?: string,
): ToolsPolicy {
  const policy: ToolsPolicy = {
    enabled: [],
    disabled: [],
    aggressiveness: {
      default: extractDefaultAggressiveness(markdown),
    },
    environmentName: environmentName ?? "",
    raw: markdown,
  };

  const headings = findToolSectionHeadings(markdown);

  for (let index = 0; index < headings.length; index += 1) {
    const current = headings[index];
    const nextStart = headings[index + 1]?.start ?? markdown.length;
    const section = markdown.slice(current.start, nextStart);

    if (!section.includes("**Status:**")) {
      continue;
    }

    const toolName = toToolKey(current.name);
    if (toolName.length === 0) {
      continue;
    }

    const status = extractStatus(section);
    const level = extractAggressiveness(section) ?? policy.aggressiveness.default;

    policy.aggressiveness[toolName] = level;

    if (status === "disabled") {
      policy.disabled.push(toolName);
      continue;
    }

    policy.enabled.push(toolName);
  }

  policy.enabled = unique(policy.enabled.filter((tool) => !policy.disabled.includes(tool)));
  policy.disabled = unique(policy.disabled);

  return policy;
}

/**
 * Build a default ToolsPolicy when no TOOLS.md is available.
 */
export function defaultToolsPolicy(environmentName: string): ToolsPolicy {
  return {
    enabled: [],
    disabled: [],
    aggressiveness: { default: DEFAULT_AGGRESSIVENESS },
    environmentName,
    raw: "",
  };
}

/**
 * Look up a specific tool's aggressiveness, falling back to the default level.
 */
export function getToolAggressiveness(
  policy: ToolsPolicy,
  toolName: string,
): AggressivenessLevel {
  const key = toToolKey(toolName);
  return policy.aggressiveness[key] ?? policy.aggressiveness.default ?? DEFAULT_AGGRESSIVENESS;
}

/**
 * Check whether a tool is enabled in the policy.
 * If the enabled list is empty (no explicit enables), unknown tools are allowed
 * unless they appear in the disabled list (opt-out model).
 */
export function isToolEnabled(policy: ToolsPolicy, toolName: string): boolean {
  const key = toToolKey(toolName);
  if (key.length === 0) {
    return false;
  }

  if (policy.disabled.includes(key)) {
    return false;
  }

  if (policy.enabled.length === 0) {
    return true;
  }

  return policy.enabled.includes(key);
}

/**
 * Validate that a ToolsPolicy is internally consistent and properly scoped.
 */
export function validateToolsPolicy(
  policy: ToolsPolicy,
): Result<void, EnvironmentError> {
  // Aggressiveness default must be a known level
  if (!isKnownAggressiveness(policy.aggressiveness.default)) {
    return err(
      new EnvironmentScopeViolationError(
        `Invalid default aggressiveness level: ${policy.aggressiveness.default}`,
      ),
    );
  }

  // Per-tool aggressiveness values must be known levels
  for (const [toolName, level] of Object.entries(policy.aggressiveness)) {
    if (toolName === "default") continue;
    if (!isKnownAggressiveness(level)) {
      return err(
        new EnvironmentScopeViolationError(
          `Invalid aggressiveness for tool "${toolName}": ${level}`,
        ),
      );
    }
  }

  // A tool must not appear in both enabled and disabled lists
  for (const tool of policy.enabled) {
    if (policy.disabled.includes(tool)) {
      return err(
        new EnvironmentScopeViolationError(
          `Tool "${tool}" appears in both enabled and disabled lists`,
        ),
      );
    }
  }

  // Tools policy must not be stored in global scope
  if (isGlobalSetting("TOOLS")) {
    return err(
      new EnvironmentScopeViolationError(
        "TOOLS policy must remain environment-scoped, not global",
      ),
    );
  }

  return ok(undefined);
}

// ---------------------------------------------------------------------------
// Internal parsing helpers
// ---------------------------------------------------------------------------

function findToolSectionHeadings(markdown: string): Array<{ name: string; start: number }> {
  const headings: Array<{ name: string; start: number }> = [];
  const headingPattern = /^###\s+(.+)$/gm;
  let match = headingPattern.exec(markdown);

  while (match !== null) {
    const name = match[1]?.trim() ?? "";
    headings.push({
      name,
      start: match.index,
    });
    match = headingPattern.exec(markdown);
  }

  return headings;
}

function extractDefaultAggressiveness(markdown: string): AggressivenessLevel {
  const defaultMatch = markdown.match(/\*\*Default Mode:\*\*\s*([^\n]+)/i);
  if (!defaultMatch) {
    return DEFAULT_AGGRESSIVENESS;
  }

  return normalizeAggressiveness(defaultMatch[1]) ?? DEFAULT_AGGRESSIVENESS;
}

function extractStatus(section: string): "enabled" | "disabled" {
  const statusMatch = section.match(/\*\*Status:\*\*\s*([^\n]+)/i);
  const status = statusMatch?.[1]?.trim().toLowerCase();
  return status === "disabled" ? "disabled" : "enabled";
}

function extractAggressiveness(section: string): AggressivenessLevel | undefined {
  const aggressivenessMatch = section.match(/\*\*Aggressiveness:\*\*\s*([^\n]+)/i);
  if (!aggressivenessMatch) {
    return undefined;
  }

  return normalizeAggressiveness(aggressivenessMatch[1]);
}

function normalizeAggressiveness(value: string): AggressivenessLevel | undefined {
  const normalized = value.trim().toLowerCase();
  return AGGRESSIVENESS_ALIASES[normalized];
}

function isKnownAggressiveness(value: string): value is AggressivenessLevel {
  return value === "low" || value === "medium" || value === "high";
}

function toToolKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
