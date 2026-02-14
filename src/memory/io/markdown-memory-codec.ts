import { err, ok, type Result } from "../../result";
import {
  CANONICAL_KEY_ORDER,
  MemoryFormatError,
  validateFrontmatter,
  type FrontmatterData,
  type MemoryFileRecord,
  type MemorySource,
} from "./frontmatter-schema";

// --- YAML Serializer (simple, controlled format) ---

function needsQuoting(value: string): boolean {
  if (value.length === 0) return true;

  // Values that look like booleans, numbers, or null
  const ambiguous = /^(true|false|yes|no|on|off|null|~|\d[\d._]*|[+-]?\.\d+|0x[\da-fA-F]+|0o[0-7]+|0b[01]+)$/i;
  if (ambiguous.test(value)) return true;

  // Values starting/ending with whitespace
  if (value !== value.trim()) return true;

  // Values containing characters that could confuse YAML parsers
  if (/[:#{}[\],&*?|>!%@`]/.test(value)) return true;

  return false;
}

function formatScalar(value: string | number | boolean | null): string {
  if (value === null) return "null";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (needsQuoting(value)) return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  return value;
}

function serializeSource(source: MemorySource): string {
  const lines: string[] = [];
  lines.push(`  type: ${formatScalar(source.type)}`);
  if (source.conversationId !== undefined) {
    lines.push(`  conversationId: ${formatScalar(source.conversationId)}`);
  }
  if (source.messageId !== undefined) {
    lines.push(`  messageId: ${formatScalar(source.messageId)}`);
  }
  return lines.join("\n");
}

function serializeArray(items: string[]): string {
  if (items.length === 0) return "[]";
  return items.map((item) => `  - ${formatScalar(item)}`).join("\n");
}

function serializeFrontmatter(data: FrontmatterData): string {
  const lines: string[] = [];

  for (const key of CANONICAL_KEY_ORDER) {
    switch (key) {
      case "id":
        lines.push(`id: ${formatScalar(data.id)}`);
        break;
      case "version":
        lines.push(`version: ${formatScalar(data.version)}`);
        break;
      case "type":
        lines.push(`type: ${formatScalar(data.type)}`);
        break;
      case "layer":
        lines.push(`layer: ${formatScalar(data.layer)}`);
        break;
      case "importance":
        lines.push(`importance: ${formatScalar(data.importance)}`);
        break;
      case "confidence":
        lines.push(`confidence: ${formatScalar(data.confidence)}`);
        break;
      case "tags":
        if (data.tags.length === 0) {
          lines.push("tags: []");
        } else {
          lines.push("tags:");
          lines.push(serializeArray(data.tags));
        }
        break;
      case "entities":
        if (data.entities.length === 0) {
          lines.push("entities: []");
        } else {
          lines.push("entities:");
          lines.push(serializeArray(data.entities));
        }
        break;
      case "source":
        lines.push("source:");
        lines.push(serializeSource(data.source));
        break;
      case "supersedes":
        lines.push(`supersedes: ${formatScalar(data.supersedes)}`);
        break;
      case "supersededBy":
        lines.push(`supersededBy: ${formatScalar(data.supersededBy)}`);
        break;
      case "createdAt":
        lines.push(`createdAt: ${formatScalar(data.createdAt)}`);
        break;
      case "updatedAt":
        lines.push(`updatedAt: ${formatScalar(data.updatedAt)}`);
        break;
      case "accessedAt":
        lines.push(`accessedAt: ${formatScalar(data.accessedAt)}`);
        break;
    }
  }

  return lines.join("\n");
}

// --- YAML Parser (simple, controlled format) ---

function unquoteString(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    return inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function parseScalar(raw: string): string | number | boolean | null {
  const trimmed = raw.trim();

  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true" || trimmed === "yes") return true;
  if (trimmed === "false" || trimmed === "no") return false;

  // Quoted strings — return as string
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return unquoteString(trimmed);
  }

  // Try number
  if (/^[+-]?\d+(\.\d+)?$/.test(trimmed)) {
    const num = Number(trimmed);
    if (!Number.isNaN(num)) return num;
  }

  // Empty array literal
  if (trimmed === "[]") return trimmed;

  return trimmed;
}

interface ParsedYaml {
  [key: string]: string | number | boolean | null | string[] | Record<string, string | number | boolean | null>;
}

function parseSimpleYaml(yaml: string): Result<ParsedYaml, MemoryFormatError> {
  const result: ParsedYaml = {};
  const lines = yaml.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Skip empty lines
    if (line === undefined || line.trim() === "" || line.trim().startsWith("#")) {
      i++;
      continue;
    }

    // Top-level key: value
    const topMatch = line.match(/^(\w+):\s*(.*)/);
    if (!topMatch) {
      return err(new MemoryFormatError(`Invalid YAML at line ${i + 1}: ${line}`));
    }

    const key = topMatch[1]!;
    const valueStr = topMatch[2]!.trim();

    // Key with inline value
    if (valueStr.length > 0) {
      if (valueStr === "[]") {
        result[key] = [];
      } else {
        const scalar = parseScalar(valueStr);
        if (typeof scalar === "string" && scalar === "[]") {
          result[key] = [];
        } else {
          result[key] = scalar;
        }
      }
      i++;
      continue;
    }

    // Key without value — could be array or nested object
    // Peek at next lines
    const nextLine = i + 1 < lines.length ? lines[i + 1] : undefined;

    if (nextLine !== undefined && nextLine.match(/^\s+-\s/)) {
      // Array
      const items: string[] = [];
      i++;
      while (i < lines.length) {
        const arrLine = lines[i];
        if (arrLine === undefined) break;
        const arrMatch = arrLine.match(/^\s+-\s+(.*)/);
        if (!arrMatch) break;
        const parsed = parseScalar(arrMatch[1]!);
        items.push(String(parsed));
        i++;
      }
      result[key] = items;
      continue;
    }

    if (nextLine !== undefined && nextLine.match(/^\s+\w+:/)) {
      // Nested object (one level deep)
      const nested: Record<string, string | number | boolean | null> = {};
      i++;
      while (i < lines.length) {
        const nestedLine = lines[i];
        if (nestedLine === undefined) break;
        const nestedMatch = nestedLine.match(/^\s+(\w+):\s*(.*)/);
        if (!nestedMatch) break;
        const nestedKey = nestedMatch[1]!;
        const nestedVal = parseScalar(nestedMatch[2]!);
        if (typeof nestedVal === "string" && nestedVal === "[]") {
          // Shouldn't happen in source, but handle gracefully
          nested[nestedKey] = nestedVal;
        } else {
          nested[nestedKey] = nestedVal;
        }
        i++;
      }
      result[key] = nested;
      continue;
    }

    // Key with no value and no nested content — treat as null
    result[key] = null;
    i++;
  }

  return ok(result);
}

function extractFrontmatter(markdown: string): Result<{ yaml: string; content: string }, MemoryFormatError> {
  const frontmatterPattern = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
  const match = markdown.match(frontmatterPattern);

  if (!match) {
    return err(new MemoryFormatError("File does not contain valid frontmatter delimiters (---)"));
  }

  return ok({
    yaml: match[1]!,
    content: match[2]!.trim(),
  });
}

// --- Public Codec API ---

export function serialize(record: MemoryFileRecord): string {
  const { content, ...frontmatter } = record;
  const yaml = serializeFrontmatter(frontmatter);
  return `---\n${yaml}\n---\n\n${content}\n`;
}

export function parse(markdown: string): Result<MemoryFileRecord, MemoryFormatError> {
  const extracted = extractFrontmatter(markdown);
  if (!extracted.ok) return extracted;

  const { yaml, content } = extracted.value;

  const parsed = parseSimpleYaml(yaml);
  if (!parsed.ok) return parsed;

  const validated = validateFrontmatter(parsed.value as Record<string, unknown>);
  if (!validated.ok) return validated;

  return ok({
    ...validated.value,
    content,
  });
}
