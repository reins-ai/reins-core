import { err, ok, type Result } from "../../result";
import { MARKETPLACE_ERROR_CODES, MarketplaceError } from "../errors";
import { MIGRATION_RULES, resolveAliases } from "./mapping-rules";
import type { DeterministicMigrationResult, MigrationReport } from "./types";

interface FrontmatterParseResult {
  frontmatter: Record<string, unknown>;
  body: string;
}

interface ParsedBlock {
  value: Record<string, unknown>;
  nextIndex: number;
}

interface ParsedArray {
  value: unknown[];
  nextIndex: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countIndent(line: string): number {
  let indent = 0;
  while (indent < line.length && line[indent] === " ") {
    indent += 1;
  }
  return indent;
}

function findNextMeaningfulLine(lines: string[], fromIndex: number): number {
  for (let index = fromIndex; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    return index;
  }
  return -1;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return "";
  }

  if (trimmed === "null" || trimmed === "~") {
    return null;
  }

  if (trimmed === "true") {
    return true;
  }

  if (trimmed === "false") {
    return false;
  }

  const isDoubleQuoted = trimmed.startsWith('"') && trimmed.endsWith('"');
  const isSingleQuoted = trimmed.startsWith("'") && trimmed.endsWith("'");
  if (isDoubleQuoted || isSingleQuoted) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }

  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") {
      return [];
    }
    return inner.split(",").map((item) => String(parseScalar(item)));
  }

  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (!Number.isNaN(numeric)) {
      return numeric;
    }
  }

  return trimmed;
}

function parseArray(lines: string[], startIndex: number, indent: number): ParsedArray {
  const value: unknown[] = [];
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    if (line.trim() === "" || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }

    const currentIndent = countIndent(line);
    if (currentIndent < indent) {
      break;
    }

    if (currentIndent > indent) {
      index += 1;
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) {
      break;
    }

    const remainder = trimmed.slice(2).trim();
    if (remainder.length > 0) {
      value.push(parseScalar(remainder));
      index += 1;
      continue;
    }

    const nestedIndex = findNextMeaningfulLine(lines, index + 1);
    if (nestedIndex === -1) {
      value.push(null);
      index += 1;
      continue;
    }

    const nestedIndent = countIndent(lines[nestedIndex] ?? "");
    if (nestedIndent <= indent) {
      value.push(null);
      index += 1;
      continue;
    }

    const parsedNested = parseObject(lines, nestedIndex, nestedIndent);
    value.push(parsedNested.value);
    index = parsedNested.nextIndex;
  }

  return { value, nextIndex: index };
}

function parseObject(lines: string[], startIndex: number, indent: number): ParsedBlock {
  const value: Record<string, unknown> = {};
  let index = startIndex;

  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) {
      break;
    }

    if (line.trim() === "" || line.trim().startsWith("#")) {
      index += 1;
      continue;
    }

    const currentIndent = countIndent(line);
    if (currentIndent < indent) {
      break;
    }

    if (currentIndent > indent) {
      index += 1;
      continue;
    }

    const trimmed = line.trim();
    const keyMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyMatch) {
      throw new Error(`Invalid YAML line: ${line}`);
    }

    const key = keyMatch[1] ?? "";
    const rawValue = keyMatch[2] ?? "";

    if (rawValue.length > 0) {
      value[key] = parseScalar(rawValue);
      index += 1;
      continue;
    }

    const nextIndex = findNextMeaningfulLine(lines, index + 1);
    if (nextIndex === -1) {
      value[key] = null;
      index += 1;
      continue;
    }

    const nextLine = lines[nextIndex] ?? "";
    const nextIndent = countIndent(nextLine);
    if (nextIndent <= currentIndent) {
      value[key] = null;
      index += 1;
      continue;
    }

    const normalizedNext = nextLine.trim();
    if (normalizedNext.startsWith("- ")) {
      const parsedArray = parseArray(lines, nextIndex, nextIndent);
      value[key] = parsedArray.value;
      index = parsedArray.nextIndex;
      continue;
    }

    const parsedObject = parseObject(lines, nextIndex, nextIndent);
    value[key] = parsedObject.value;
    index = parsedObject.nextIndex;
  }

  return { value, nextIndex: index };
}

function parseYamlBlock(yaml: string): Record<string, unknown> {
  const lines = yaml.replace(/\r/g, "").split("\n");
  const startIndex = findNextMeaningfulLine(lines, 0);
  if (startIndex === -1) {
    return {};
  }

  const parsed = parseObject(lines, startIndex, countIndent(lines[startIndex] ?? ""));
  return parsed.value;
}

function parseFrontmatter(input: string): Result<FrontmatterParseResult, MarketplaceError> {
  const normalized = input.replace(/^\uFEFF/, "");
  const match = normalized.match(/^---\r?\n([\s\S]*?)\r?\n---([\s\S]*)$/);

  if (!match) {
    return err(
      new MarketplaceError(
        "OpenClaw skill content is missing YAML frontmatter delimiters",
        MARKETPLACE_ERROR_CODES.INVALID_RESPONSE,
      ),
    );
  }

  const yaml = match[1] ?? "";
  const body = match[2] ?? "";

  try {
    const frontmatter = parseYamlBlock(yaml);
    return ok({ frontmatter, body });
  } catch (error) {
    return err(
      new MarketplaceError(
        "Failed to parse OpenClaw YAML frontmatter",
        MARKETPLACE_ERROR_CODES.INVALID_RESPONSE,
        error instanceof Error ? error : undefined,
      ),
    );
  }
}

function getPath(record: Record<string, unknown>, path: string): unknown {
  const segments = path.split(".");
  let current: unknown = record;

  for (const segment of segments) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }

  return current;
}

function setPath(record: Record<string, unknown>, path: string, value: unknown): void {
  const segments = path.split(".");
  let current = record;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    const isLast = index === segments.length - 1;

    if (isLast) {
      current[segment] = value;
      return;
    }

    const next = current[segment];
    if (!isRecord(next)) {
      current[segment] = {};
    }

    current = current[segment] as Record<string, unknown>;
  }
}

function deletePath(record: Record<string, unknown>, path: string): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = record;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? "";
    const isLast = index === segments.length - 1;

    if (isLast) {
      delete current[segment];
      return;
    }

    const next = current[segment];
    if (!isRecord(next)) {
      return;
    }
    current = next;
  }
}

function flattenObjectPaths(
  record: Record<string, unknown>,
  prefix: string,
  output: string[],
): void {
  for (const [key, value] of Object.entries(record)) {
    const path = `${prefix}.${key}`;
    if (isRecord(value)) {
      flattenObjectPaths(value, path, output);
      continue;
    }
    output.push(path);
  }
}

function normalizeSourceFrontmatter(frontmatter: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...frontmatter };
  const metadata = isRecord(normalized.metadata) ? normalized.metadata : {};
  normalized.metadata = resolveAliases(metadata);
  return normalized;
}

function buildBaseReport(): MigrationReport {
  return {
    warnings: [],
    mappedFields: [],
    unmappedFields: [],
    usedLlm: false,
  };
}

export function deterministicMapper(
  openClawContent: string,
): Result<DeterministicMigrationResult, MarketplaceError> {
  const parsed = parseFrontmatter(openClawContent);
  if (!parsed.ok) {
    return parsed;
  }

  const report = buildBaseReport();
  const normalizedSource = normalizeSourceFrontmatter(parsed.value.frontmatter);
  const targetFrontmatter: Record<string, unknown> = {
    trustLevel: "community",
  };

  for (const rule of MIGRATION_RULES) {
    const sourceValue = getPath(normalizedSource, rule.source);
    if (sourceValue === undefined) {
      continue;
    }

    const mappedValue = rule.transform ? rule.transform(sourceValue) : sourceValue;

    if (mappedValue === undefined) {
      continue;
    }

    setPath(targetFrontmatter, rule.target, mappedValue);
    report.mappedFields.push(`${rule.source} -> ${rule.target}`);
  }

  const openclawMetadata = getPath(normalizedSource, "metadata.openclaw");
  if (isRecord(openclawMetadata)) {
    const openclawRemainder: Record<string, unknown> = structuredClone(openclawMetadata);

    for (const mappedPath of ["requires.env", "requires.bins", "os", "emoji", "homepage", "tags"]) {
      deletePath(openclawRemainder, mappedPath);
    }

    if (Object.keys(openclawRemainder).length > 0) {
      targetFrontmatter.openclawMetadata = openclawRemainder;
      flattenObjectPaths(openclawRemainder, "metadata.openclaw", report.unmappedFields);
    }
  }

  return ok({
    frontmatter: targetFrontmatter,
    body: parsed.value.body,
    report,
  });
}
