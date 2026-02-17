import type { MappingRule } from "./types";

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export const MIGRATION_RULES: MappingRule[] = [
  { source: "name", target: "name" },
  { source: "description", target: "description" },
  { source: "version", target: "version" },
  { source: "author", target: "author" },
  {
    source: "triggers",
    target: "triggers",
    transform: toStringArray,
  },
  {
    source: "metadata.openclaw.requires.env",
    target: "config.envVars",
    transform: toStringArray,
  },
  {
    source: "metadata.openclaw.requires.bins",
    target: "requiredTools",
    transform: toStringArray,
  },
  {
    source: "metadata.openclaw.os",
    target: "platforms",
    transform: toStringArray,
  },
  {
    source: "metadata.openclaw.emoji",
    target: "emoji",
    transform: toStringOrUndefined,
  },
  {
    source: "metadata.openclaw.homepage",
    target: "homepage",
    transform: toStringOrUndefined,
  },
  {
    source: "metadata.openclaw.tags",
    target: "categories",
    transform: toStringArray,
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

export function resolveAliases(metadata: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...metadata };
  const openclaw = asRecord(normalized.openclaw);

  if (openclaw) {
    normalized.openclaw = openclaw;
    return normalized;
  }

  const clawdbot = asRecord(normalized.clawdbot);
  if (clawdbot) {
    normalized.openclaw = clawdbot;
    return normalized;
  }

  const clawdis = asRecord(normalized.clawdis);
  if (clawdis) {
    normalized.openclaw = clawdis;
  }

  return normalized;
}
