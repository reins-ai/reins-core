import { readFile } from "node:fs/promises";

import { SkillError } from "./errors";
import { validateMetadata, type SkillMetadata } from "./metadata";
import { type Result, err, ok } from "../result";

export interface ParsedSkill {
  metadata: SkillMetadata;
  body: string;
  raw: string;
}

const FRONTMATTER_DELIMITER = "---";

/**
 * Parse a simple YAML subset used in SKILL.md frontmatter.
 *
 * Supports:
 * - String values: `key: value`
 * - Quoted string values: `key: "value"` or `key: 'value'`
 * - Inline arrays: `key: [item1, item2]`
 * - Block arrays: `key:\n  - item1\n  - item2`
 * - One-level nested objects: `config:\n  envVars:\n    - VAR1`
 */
export function parseYamlFrontmatter(yaml: string): Result<Record<string, unknown>, SkillError> {
  const result: Record<string, unknown> = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines and comment lines
    if (line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    // Must be a top-level key (no leading whitespace)
    if (line.startsWith(" ") || line.startsWith("\t")) {
      return err(new SkillError(`Failed to parse YAML frontmatter: unexpected indentation at line ${i + 1}`));
    }

    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      return err(new SkillError(`Failed to parse YAML frontmatter: missing colon at line ${i + 1}`));
    }

    const key = line.slice(0, colonIndex).trim();
    const rawValue = line.slice(colonIndex + 1).trim();

    if (key === "") {
      return err(new SkillError(`Failed to parse YAML frontmatter: empty key at line ${i + 1}`));
    }

    if (rawValue === "") {
      // Could be a block array or nested object — peek at next lines
      const blockResult = parseBlock(lines, i + 1);
      result[key] = blockResult.value;
      i = blockResult.nextIndex;
    } else if (rawValue.startsWith("[")) {
      // Inline array: [item1, item2]
      const arrayResult = parseInlineArray(rawValue, i + 1);
      if (!arrayResult.ok) {
        return arrayResult;
      }
      result[key] = arrayResult.value;
      i++;
    } else {
      // Scalar value
      result[key] = unquote(rawValue);
      i++;
    }
  }

  return ok(result);
}

/**
 * Parse a block that starts with indented content (arrays or nested objects).
 */
function parseBlock(
  lines: string[],
  startIndex: number,
): { value: unknown; nextIndex: number } {
  // Determine what kind of block this is by looking at the first indented line
  let firstContentIndex = startIndex;
  while (firstContentIndex < lines.length && lines[firstContentIndex].trim() === "") {
    firstContentIndex++;
  }

  if (firstContentIndex >= lines.length || !isIndented(lines[firstContentIndex])) {
    // Empty block — treat as empty string
    return { value: "", nextIndex: startIndex };
  }

  const firstLine = lines[firstContentIndex];
  const trimmed = firstLine.trim();

  if (trimmed.startsWith("- ")) {
    // Block array
    return parseBlockArray(lines, startIndex);
  }

  // Nested object (one level)
  return parseNestedObject(lines, startIndex);
}

/**
 * Parse a block-style YAML array:
 * ```
 *   - item1
 *   - item2
 * ```
 */
function parseBlockArray(
  lines: string[],
  startIndex: number,
): { value: string[]; nextIndex: number } {
  const items: string[] = [];
  let i = startIndex;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (!isIndented(line)) {
      break;
    }

    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      items.push(unquote(trimmed.slice(2).trim()));
      i++;
    } else {
      // Not an array item — end of block
      break;
    }
  }

  return { value: items, nextIndex: i };
}

/**
 * Parse a one-level nested object:
 * ```
 * config:
 *   envVars:
 *     - VAR1
 *   stateDirs:
 *     - /path
 * ```
 */
function parseNestedObject(
  lines: string[],
  startIndex: number,
): { value: Record<string, unknown>; nextIndex: number } {
  const obj: Record<string, unknown> = {};
  let i = startIndex;

  // Determine the indentation level of the first key
  while (i < lines.length && lines[i].trim() === "") {
    i++;
  }

  if (i >= lines.length || !isIndented(lines[i])) {
    return { value: obj, nextIndex: i };
  }

  const baseIndent = getIndentLevel(lines[i]);

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    const indent = getIndentLevel(line);

    if (indent < baseIndent) {
      // Back to parent level
      break;
    }

    if (indent > baseIndent) {
      // This is a sub-item of the previous key — skip (handled by sub-key parsing)
      i++;
      continue;
    }

    // Same indent level — this is a key in the nested object
    const trimmed = line.trim();
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      break;
    }

    const key = trimmed.slice(0, colonIndex).trim();
    const rawValue = trimmed.slice(colonIndex + 1).trim();

    if (rawValue === "") {
      // Sub-block (array or deeper nesting)
      const subBlock = parseBlockArray(lines, i + 1);
      obj[key] = subBlock.value;
      i = subBlock.nextIndex;
    } else if (rawValue.startsWith("[")) {
      const parsed = parseInlineArrayUnsafe(rawValue);
      obj[key] = parsed;
      i++;
    } else {
      obj[key] = unquote(rawValue);
      i++;
    }
  }

  return { value: obj, nextIndex: i };
}

/**
 * Parse an inline YAML array: `[item1, item2, item3]`
 */
function parseInlineArray(raw: string, lineNumber: number): Result<string[], SkillError> {
  if (!raw.endsWith("]")) {
    return err(new SkillError(`Failed to parse YAML frontmatter: unclosed inline array at line ${lineNumber}`));
  }

  const inner = raw.slice(1, -1).trim();
  if (inner === "") {
    return ok([]);
  }

  const items = inner.split(",").map((item) => unquote(item.trim()));
  return ok(items);
}

/**
 * Parse an inline array without Result wrapping (for nested contexts).
 */
function parseInlineArrayUnsafe(raw: string): string[] {
  if (!raw.endsWith("]")) {
    return [raw];
  }

  const inner = raw.slice(1, -1).trim();
  if (inner === "") {
    return [];
  }

  return inner.split(",").map((item) => unquote(item.trim()));
}

/**
 * Remove surrounding quotes from a string value.
 */
function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isIndented(line: string): boolean {
  return line.startsWith(" ") || line.startsWith("\t");
}

function getIndentLevel(line: string): number {
  let count = 0;
  for (const ch of line) {
    if (ch === " ") {
      count++;
    } else if (ch === "\t") {
      count += 2;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Extract YAML frontmatter and markdown body from SKILL.md content.
 *
 * Frontmatter must be delimited by `---` at the start and a second `---`.
 * Everything after the closing delimiter is the markdown body.
 */
function extractFrontmatter(content: string): Result<{ yaml: string; body: string }, SkillError> {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith(FRONTMATTER_DELIMITER)) {
    return err(new SkillError("SKILL.md must start with YAML frontmatter delimiters (---)"));
  }

  // Find the closing delimiter after the opening one
  const afterOpening = trimmed.slice(FRONTMATTER_DELIMITER.length);
  const closingIndex = afterOpening.indexOf(`\n${FRONTMATTER_DELIMITER}`);

  if (closingIndex === -1) {
    return err(new SkillError("SKILL.md is missing closing frontmatter delimiter (---)"));
  }

  const yaml = afterOpening.slice(0, closingIndex).trim();
  // Skip past the closing delimiter line
  const afterClosing = afterOpening.slice(closingIndex + 1 + FRONTMATTER_DELIMITER.length);
  // Find the end of the closing delimiter line (skip any trailing content on that line)
  const newlineAfterClosing = afterClosing.indexOf("\n");
  const body = newlineAfterClosing === -1 ? "" : afterClosing.slice(newlineAfterClosing + 1);

  return ok({ yaml, body: body.trim() });
}

/**
 * Parse SKILL.md content string into structured data.
 *
 * Extracts YAML frontmatter, validates it via `validateMetadata()`,
 * and separates the markdown body.
 */
export function parseSkillMd(content: string): Result<ParsedSkill, SkillError> {
  if (content.trim() === "") {
    return err(new SkillError("SKILL.md content is empty"));
  }

  const frontmatterResult = extractFrontmatter(content);
  if (!frontmatterResult.ok) {
    return frontmatterResult;
  }

  const { yaml, body } = frontmatterResult.value;

  if (yaml.trim() === "") {
    return err(new SkillError("SKILL.md frontmatter is empty"));
  }

  const yamlResult = parseYamlFrontmatter(yaml);
  if (!yamlResult.ok) {
    return yamlResult;
  }

  const metadataResult = validateMetadata(yamlResult.value);
  if (!metadataResult.ok) {
    return metadataResult;
  }

  return ok({
    metadata: metadataResult.value,
    body,
    raw: content,
  });
}

/**
 * Read and parse a SKILL.md file from the filesystem.
 *
 * Reads the file at `filePath`, then delegates to `parseSkillMd()`.
 */
export async function readSkillMd(filePath: string): Promise<Result<ParsedSkill, SkillError>> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new SkillError(`Failed to read SKILL.md at "${filePath}": ${message}`));
  }

  return parseSkillMd(content);
}
