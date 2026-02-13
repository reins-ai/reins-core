import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { serialize, parse } from "../../../src/memory/io/markdown-memory-codec";
import {
  validateFrontmatter,
  MemoryFormatError,
  CANONICAL_KEY_ORDER,
  type MemoryFileRecord,
} from "../../../src/memory/io/frontmatter-schema";

function createRecord(overrides?: Partial<MemoryFileRecord>): MemoryFileRecord {
  return {
    id: "01JKMP3QR7XYZABC1234567890",
    version: 1,
    type: "fact",
    layer: "ltm",
    importance: 0.8,
    confidence: 0.9,
    tags: ["programming", "typescript"],
    entities: ["James"],
    source: {
      type: "explicit",
      conversationId: "conv_abc123",
    },
    supersedes: null,
    supersededBy: null,
    createdAt: "2026-02-13T19:00:00.000Z",
    updatedAt: "2026-02-13T19:00:00.000Z",
    accessedAt: "2026-02-13T19:00:00.000Z",
    content: "User prefers TypeScript strict mode and avoids `any` types in all projects.",
    ...overrides,
  };
}

describe("MarkdownMemoryCodec", () => {
  describe("round-trip fidelity", () => {
    test("serialize then parse produces identical record", () => {
      const original = createRecord();
      const markdown = serialize(original);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toEqual(original);
    });

    test("serialize then parse then serialize produces identical output", () => {
      const original = createRecord();
      const firstPass = serialize(original);
      const parsed = parse(firstPass);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const secondPass = serialize(parsed.value);
      expect(secondPass).toBe(firstPass);
    });

    test("round-trips with all optional source fields", () => {
      const record = createRecord({
        source: {
          type: "implicit",
          conversationId: "conv_xyz",
          messageId: "msg_456",
        },
      });

      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.source).toEqual({
        type: "implicit",
        conversationId: "conv_xyz",
        messageId: "msg_456",
      });
    });

    test("round-trips with empty tags and entities", () => {
      const record = createRecord({ tags: [], entities: [] });
      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.tags).toEqual([]);
      expect(result.value.entities).toEqual([]);
    });

    test("round-trips with supersession chain", () => {
      const record = createRecord({
        supersedes: "01JKMP_OLD_RECORD",
        supersededBy: "01JKMP_NEW_RECORD",
      });

      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.supersedes).toBe("01JKMP_OLD_RECORD");
      expect(result.value.supersededBy).toBe("01JKMP_NEW_RECORD");
    });

    test("round-trips with minimal source (no optional fields)", () => {
      const record = createRecord({
        source: { type: "consolidation" },
      });

      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.source).toEqual({ type: "consolidation" });
      expect(result.value.source.conversationId).toBeUndefined();
      expect(result.value.source.messageId).toBeUndefined();
    });
  });

  describe("golden fixture", () => {
    test("parses the golden fixture file", () => {
      const fixturePath = join(import.meta.dir, "../fixtures/memory-sample.md");
      const content = readFileSync(fixturePath, "utf-8");
      const result = parse(content);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBe("01JKMP3QR7XYZABC1234567890");
      expect(result.value.type).toBe("fact");
      expect(result.value.layer).toBe("ltm");
      expect(result.value.importance).toBe(0.8);
      expect(result.value.confidence).toBe(0.9);
      expect(result.value.tags).toEqual(["programming", "typescript"]);
      expect(result.value.entities).toEqual(["James"]);
      expect(result.value.source.type).toBe("explicit");
      expect(result.value.source.conversationId).toBe("conv_abc123");
      expect(result.value.supersedes).toBeNull();
      expect(result.value.supersededBy).toBeNull();
      expect(result.value.content).toBe(
        "User prefers TypeScript strict mode and avoids `any` types in all projects.",
      );
    });

    test("golden fixture round-trips perfectly", () => {
      const fixturePath = join(import.meta.dir, "../fixtures/memory-sample.md");
      const original = readFileSync(fixturePath, "utf-8");
      const parsed = parse(original);

      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      const reserialized = serialize(parsed.value);
      expect(reserialized).toBe(original);
    });
  });

  describe("parse", () => {
    test("parses valid memory file", () => {
      const markdown = serialize(createRecord());
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.id).toBe("01JKMP3QR7XYZABC1234567890");
      expect(result.value.version).toBe(1);
      expect(result.value.type).toBe("fact");
    });

    test("rejects file without frontmatter", () => {
      const result = parse("Just some plain text without frontmatter.");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(MemoryFormatError);
      expect(result.error.message).toContain("frontmatter");
    });

    test("rejects file with only opening delimiter", () => {
      const result = parse("---\nid: test\nNo closing delimiter");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(MemoryFormatError);
    });

    test("rejects file with invalid importance (above 1)", () => {
      const record = createRecord({ importance: 1.5 });
      // Manually construct to bypass serializer
      const markdown = serialize(record).replace("importance: 1.5", "importance: 1.5");
      const result = parse(markdown);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("importance");
    });

    test("rejects file with invalid importance (below 0)", () => {
      const markdown = serialize(createRecord()).replace("importance: 0.8", "importance: -0.5");
      const result = parse(markdown);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("importance");
    });

    test("rejects file with unknown memory type", () => {
      const markdown = serialize(createRecord()).replace("type: fact", "type: banana");
      const result = parse(markdown);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("type");
    });

    test("rejects file with invalid layer", () => {
      const markdown = serialize(createRecord()).replace("layer: ltm", "layer: invalid");
      const result = parse(markdown);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("layer");
    });

    test("handles missing optional fields with defaults", () => {
      const yaml = [
        "---",
        'id: "test-id"',
        "type: fact",
        "layer: stm",
        "importance: 0.5",
        "source:",
        "  type: explicit",
        '"2026-01-01T00:00:00.000Z"',
        '"2026-01-01T00:00:00.000Z"',
        '"2026-01-01T00:00:00.000Z"',
        "---",
        "",
        "Some content.",
      ].join("\n");

      // Build a proper file with defaults applied
      const minimalYaml = [
        "---",
        'id: "test-id"',
        "type: fact",
        "layer: stm",
        "importance: 0.5",
        "source:",
        "  type: explicit",
        'createdAt: "2026-01-01T00:00:00.000Z"',
        'updatedAt: "2026-01-01T00:00:00.000Z"',
        'accessedAt: "2026-01-01T00:00:00.000Z"',
        "---",
        "",
        "Some content.",
      ].join("\n");

      const result = parse(minimalYaml);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Defaults applied
      expect(result.value.version).toBe(1);
      expect(result.value.confidence).toBe(1.0);
      expect(result.value.tags).toEqual([]);
      expect(result.value.entities).toEqual([]);
      expect(result.value.supersedes).toBeNull();
      expect(result.value.supersededBy).toBeNull();
    });
  });

  describe("serialize", () => {
    test("outputs frontmatter with canonical key order", () => {
      const record = createRecord();
      const output = serialize(record);

      const lines = output.split("\n");
      // Find key lines (skip --- delimiters, array items, nested keys)
      const keyLines = lines.filter(
        (line) => /^\w+:/.test(line),
      );

      const keys = keyLines.map((line) => line.split(":")[0]!);

      // Verify order matches CANONICAL_KEY_ORDER
      let lastIndex = -1;
      for (const key of keys) {
        const index = CANONICAL_KEY_ORDER.indexOf(key as (typeof CANONICAL_KEY_ORDER)[number]);
        expect(index).toBeGreaterThan(lastIndex);
        lastIndex = index;
      }
    });

    test("ends file with single newline", () => {
      const output = serialize(createRecord());
      expect(output.endsWith("\n")).toBe(true);
      expect(output.endsWith("\n\n")).toBe(false);
    });

    test("uses 2-space indentation for arrays", () => {
      const record = createRecord({ tags: ["alpha", "beta"] });
      const output = serialize(record);

      expect(output).toContain("  - alpha");
      expect(output).toContain("  - beta");
    });

    test("uses 2-space indentation for nested source object", () => {
      const record = createRecord({
        source: { type: "explicit", conversationId: "conv_123" },
      });
      const output = serialize(record);

      expect(output).toContain("source:\n  type: explicit\n  conversationId: ");
    });

    test("serializes empty arrays as inline []", () => {
      const record = createRecord({ tags: [], entities: [] });
      const output = serialize(record);

      expect(output).toContain("tags: []");
      expect(output).toContain("entities: []");
    });

    test("serializes null values as null", () => {
      const record = createRecord({ supersedes: null, supersededBy: null });
      const output = serialize(record);

      expect(output).toContain("supersedes: null");
      expect(output).toContain("supersededBy: null");
    });

    test("quotes string values that could be ambiguous YAML", () => {
      const record = createRecord({
        id: "true",
        tags: ["yes", "null", "123"],
      });
      const output = serialize(record);

      expect(output).toContain('id: "true"');
      expect(output).toContain('  - "yes"');
      expect(output).toContain('  - "null"');
      expect(output).toContain('  - "123"');
    });
  });

  describe("multi-line content", () => {
    test("handles multi-line content body", () => {
      const record = createRecord({
        content: "First paragraph.\n\nSecond paragraph with details.\n\nThird paragraph.",
      });

      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toBe(
        "First paragraph.\n\nSecond paragraph with details.\n\nThird paragraph.",
      );
    });

    test("handles content with code blocks", () => {
      const content = [
        "User prefers this pattern:",
        "",
        "```typescript",
        'const result = ok({ value: "test" });',
        "if (!result.ok) return;",
        "```",
        "",
        "Always use Result types at boundaries.",
      ].join("\n");

      const record = createRecord({ content });
      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toBe(content);
    });

    test("handles content with backticks and special characters", () => {
      const content =
        "Use `bun test` for testing. Avoid `any` types. Use `Result<T>` at boundaries.";

      const record = createRecord({ content });
      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toBe(content);
    });

    test("handles content with YAML-like syntax in body", () => {
      const content = "The config uses:\n---\nkey: value\n---\nBut that is inside the body.";

      const record = createRecord({ content });
      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toBe(content);
    });

    test("handles content with markdown headers", () => {
      const content = "# Main Topic\n\n## Sub Topic\n\nSome details here.";

      const record = createRecord({ content });
      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toBe(content);
    });

    test("trims leading and trailing whitespace from content", () => {
      const markdown = [
        "---",
        'id: "test-id"',
        "version: 1",
        "type: fact",
        "layer: stm",
        "importance: 0.5",
        "confidence: 0.9",
        "tags: []",
        "entities: []",
        "source:",
        "  type: explicit",
        "supersedes: null",
        "supersededBy: null",
        'createdAt: "2026-01-01T00:00:00.000Z"',
        'updatedAt: "2026-01-01T00:00:00.000Z"',
        'accessedAt: "2026-01-01T00:00:00.000Z"',
        "---",
        "",
        "  ",
        "  Content with surrounding whitespace.  ",
        "  ",
        "",
      ].join("\n");

      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toBe("Content with surrounding whitespace.");
    });
  });

  describe("all memory types", () => {
    const validTypes = ["fact", "preference", "decision", "episode", "skill", "entity", "document_chunk"];

    for (const memType of validTypes) {
      test(`accepts type: ${memType}`, () => {
        const record = createRecord({ type: memType });
        const markdown = serialize(record);
        const result = parse(markdown);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.type).toBe(memType);
      });
    }
  });

  describe("all source types", () => {
    const validSourceTypes = ["explicit", "implicit", "compaction", "consolidation", "document"];

    for (const sourceType of validSourceTypes) {
      test(`accepts source type: ${sourceType}`, () => {
        const record = createRecord({
          source: { type: sourceType },
        });
        const markdown = serialize(record);
        const result = parse(markdown);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.source.type).toBe(sourceType);
      });
    }
  });

  describe("all persisted layers", () => {
    for (const layer of ["stm", "ltm"]) {
      test(`accepts layer: ${layer}`, () => {
        const record = createRecord({ layer });
        const markdown = serialize(record);
        const result = parse(markdown);

        expect(result.ok).toBe(true);
        if (!result.ok) return;

        expect(result.value.layer).toBe(layer);
      });
    }

    test("rejects working layer (not persisted)", () => {
      const markdown = serialize(createRecord()).replace("layer: ltm", "layer: working");
      const result = parse(markdown);

      expect(result.ok).toBe(false);
    });
  });

  describe("validateFrontmatter", () => {
    test("returns field-level errors for multiple invalid fields", () => {
      const result = validateFrontmatter({
        id: "",
        type: "invalid",
        layer: "invalid",
        importance: 2.0,
        confidence: -1,
        source: { type: "invalid" },
        createdAt: "not-a-date",
        updatedAt: "not-a-date",
        accessedAt: "not-a-date",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("id");
      expect(result.error.message).toContain("type");
      expect(result.error.message).toContain("layer");
      expect(result.error.message).toContain("importance");
      expect(result.error.message).toContain("confidence");
      expect(result.error.message).toContain("source.type");
      expect(result.error.message).toContain("createdAt");
    });

    test("accepts boundary values for importance and confidence", () => {
      const result = validateFrontmatter({
        id: "test",
        version: 1,
        type: "fact",
        layer: "stm",
        importance: 0,
        confidence: 1,
        tags: [],
        entities: [],
        source: { type: "explicit" },
        supersedes: null,
        supersededBy: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        accessedAt: "2026-01-01T00:00:00.000Z",
      });

      expect(result.ok).toBe(true);
    });

    test("rejects non-array tags", () => {
      const result = validateFrontmatter({
        id: "test",
        type: "fact",
        layer: "stm",
        importance: 0.5,
        source: { type: "explicit" },
        tags: "not-an-array",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        accessedAt: "2026-01-01T00:00:00.000Z",
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("tags");
    });
  });

  describe("edge cases", () => {
    test("handles entities with special characters", () => {
      const record = createRecord({
        entities: ["O'Brien", "Dr. Smith"],
      });

      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.entities).toEqual(["O'Brien", "Dr. Smith"]);
    });

    test("handles tags with hyphens and dots", () => {
      const record = createRecord({
        tags: ["react-native", "node.js", "type-script"],
      });

      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.tags).toEqual(["react-native", "node.js", "type-script"]);
    });

    test("handles importance and confidence at exact boundaries", () => {
      const record = createRecord({ importance: 0, confidence: 1 });
      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.importance).toBe(0);
      expect(result.value.confidence).toBe(1);
    });

    test("handles empty content body", () => {
      const record = createRecord({ content: "" });
      const markdown = serialize(record);
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toBe("");
    });

    test("handles content that is only whitespace", () => {
      const markdown = serialize(createRecord()).replace(
        "User prefers TypeScript strict mode and avoids `any` types in all projects.",
        "   \n  \n   ",
      );
      const result = parse(markdown);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toBe("");
    });
  });
});
