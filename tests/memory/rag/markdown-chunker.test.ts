import { describe, expect, test } from "bun:test";

import {
  ChunkingError,
  DEFAULT_CHUNKING_CONFIG,
  MarkdownChunker,
  type ChunkingConfig,
  type DocumentChunk,
} from "../../../src/memory/rag/markdown-chunker";

function makeChunker(overrides?: Partial<ChunkingConfig>): MarkdownChunker {
  return new MarkdownChunker(overrides);
}

function chunkOk(chunker: MarkdownChunker, content: string, path = "doc.md", sourceId = "src-1"): DocumentChunk[] {
  const result = chunker.chunk(content, path, sourceId);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

// ---------------------------------------------------------------------------
// Heading-aware chunking
// ---------------------------------------------------------------------------

describe("MarkdownChunker", () => {
  describe("heading-aware chunking (default)", () => {
    test("chunks a multi-section document by headings", () => {
      const content = [
        "# Introduction",
        "",
        "This is the intro paragraph.",
        "",
        "## Getting Started",
        "",
        "Follow these steps to get started.",
        "",
        "## Advanced Usage",
        "",
        "Here is advanced content.",
      ].join("\n");

      const chunks = chunkOk(makeChunker(), content);

      expect(chunks.length).toBeGreaterThanOrEqual(3);
      expect(chunks[0].content).toContain("Introduction");
      expect(chunks[1].content).toContain("Getting Started");
      expect(chunks[2].content).toContain("Advanced Usage");
    });

    test("respects heading boundaries and does not split mid-section when under max size", () => {
      const content = [
        "# Section A",
        "",
        "Short content A.",
        "",
        "# Section B",
        "",
        "Short content B.",
      ].join("\n");

      const chunker = makeChunker({ maxChunkSize: 2000 });
      const chunks = chunkOk(chunker, content);

      // Each section should be its own chunk (plus overlap on second)
      expect(chunks.length).toBe(2);
      expect(chunks[0].content).toContain("Section A");
      expect(chunks[0].content).toContain("Short content A.");
      expect(chunks[1].content).toContain("Section B");
    });

    test("splits large sections at paragraph boundaries", () => {
      const paragraphs = Array.from({ length: 10 }, (_, i) =>
        `Paragraph ${i + 1}. ${"This is filler text to make the paragraph longer. ".repeat(5)}`
      );
      const content = [
        "# Big Section",
        "",
        ...paragraphs.flatMap((p) => [p, ""]),
      ].join("\n");

      const chunker = makeChunker({ maxChunkSize: 500, overlapSize: 50 });
      const chunks = chunkOk(chunker, content);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.heading).toBe("# Big Section");
      }
    });

    test("tracks heading hierarchy correctly", () => {
      const content = [
        "# Guide",
        "",
        "Top level.",
        "",
        "## Getting Started",
        "",
        "Getting started content.",
        "",
        "### Installation",
        "",
        "Install instructions.",
        "",
        "### Configuration",
        "",
        "Config instructions.",
        "",
        "## Advanced",
        "",
        "Advanced content.",
      ].join("\n");

      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, content);

      const installChunk = chunks.find((c) => c.content.includes("Install instructions"));
      expect(installChunk).toBeDefined();
      expect(installChunk!.headingHierarchy).toEqual([
        "# Guide",
        "## Getting Started",
        "### Installation",
      ]);

      const configChunk = chunks.find((c) => c.content.includes("Config instructions"));
      expect(configChunk).toBeDefined();
      expect(configChunk!.headingHierarchy).toEqual([
        "# Guide",
        "## Getting Started",
        "### Configuration",
      ]);

      const advancedChunk = chunks.find((c) => c.heading === "## Advanced");
      expect(advancedChunk).toBeDefined();
      expect(advancedChunk!.headingHierarchy).toEqual([
        "# Guide",
        "## Advanced",
      ]);
    });

    test("handles content before first heading", () => {
      const content = [
        "Some preamble text before any heading.",
        "",
        "# First Section",
        "",
        "Section content.",
      ].join("\n");

      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, content);

      expect(chunks.length).toBe(2);
      expect(chunks[0].heading).toBeNull();
      expect(chunks[0].content).toContain("preamble");
      expect(chunks[1].heading).toBe("# First Section");
    });
  });

  // ---------------------------------------------------------------------------
  // Overlap
  // ---------------------------------------------------------------------------

  describe("overlap", () => {
    test("applies overlap between consecutive chunks", () => {
      const content = [
        "# Section One",
        "",
        "Content of section one ends here.",
        "",
        "# Section Two",
        "",
        "Content of section two starts here.",
      ].join("\n");

      const chunker = makeChunker({ overlapSize: 10 });
      const chunks = chunkOk(chunker, content);

      expect(chunks.length).toBe(2);
      // Second chunk should start with overlap from first chunk's end
      const firstEnd = chunks[0].content.slice(-10);
      expect(chunks[1].content.startsWith(firstEnd)).toBe(true);
    });

    test("first chunk has no overlap prefix", () => {
      const content = [
        "# A",
        "",
        "Content A.",
        "",
        "# B",
        "",
        "Content B.",
      ].join("\n");

      const chunker = makeChunker({ overlapSize: 5 });
      const chunks = chunkOk(chunker, content);

      expect(chunks[0].content).toStartWith("# A");
    });

    test("zero overlap produces no overlap", () => {
      const content = [
        "# A",
        "",
        "Content A.",
        "",
        "# B",
        "",
        "Content B.",
      ].join("\n");

      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, content);

      expect(chunks.length).toBe(2);
      // No overlap means second chunk starts with its own heading
      expect(chunks[1].content).toStartWith("# B");
    });
  });

  // ---------------------------------------------------------------------------
  // Fixed-size chunking
  // ---------------------------------------------------------------------------

  describe("fixed-size chunking", () => {
    test("splits content into fixed-size windows", () => {
      const content = "A".repeat(500);
      const chunker = makeChunker({ strategy: "fixed", maxChunkSize: 200, overlapSize: 50 });
      const chunks = chunkOk(chunker, content);

      expect(chunks.length).toBeGreaterThan(1);
      // First chunk should be exactly maxChunkSize
      expect(chunks[0].content.length).toBe(200);
    });

    test("fixed chunks have no heading info", () => {
      const content = "# Heading\n\nSome text here. ".repeat(10);
      const chunker = makeChunker({ strategy: "fixed", maxChunkSize: 100, overlapSize: 20 });
      const chunks = chunkOk(chunker, content);

      for (const chunk of chunks) {
        expect(chunk.heading).toBeNull();
        expect(chunk.headingHierarchy).toEqual([]);
      }
    });

    test("fixed chunks include overlap from previous chunk", () => {
      const content = "ABCDEFGHIJ".repeat(10); // 100 chars
      const chunker = makeChunker({ strategy: "fixed", maxChunkSize: 30, overlapSize: 10 });
      const chunks = chunkOk(chunker, content);

      expect(chunks.length).toBeGreaterThan(1);
      // Second chunk should start with last 10 chars of first chunk's window
      if (chunks.length >= 2) {
        const firstEnd = chunks[0].content.slice(-10);
        expect(chunks[1].content.startsWith(firstEnd)).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Paragraph chunking
  // ---------------------------------------------------------------------------

  describe("paragraph chunking", () => {
    test("splits at double-newlines", () => {
      const content = [
        "First paragraph with some text.",
        "",
        "Second paragraph with more text.",
        "",
        "Third paragraph with final text.",
      ].join("\n");

      const chunker = makeChunker({ strategy: "paragraph", maxChunkSize: 2000, overlapSize: 0 });
      const chunks = chunkOk(chunker, content);

      // All paragraphs fit in one chunk
      expect(chunks.length).toBe(1);
      expect(chunks[0].content).toContain("First paragraph");
      expect(chunks[0].content).toContain("Third paragraph");
    });

    test("merges small paragraphs into one chunk", () => {
      const content = [
        "Short A.",
        "",
        "Short B.",
        "",
        "Short C.",
      ].join("\n");

      const chunker = makeChunker({ strategy: "paragraph", maxChunkSize: 500, overlapSize: 0 });
      const chunks = chunkOk(chunker, content);

      expect(chunks.length).toBe(1);
    });

    test("splits when paragraphs exceed max size", () => {
      const longParagraph = "Word ".repeat(100);
      const content = [
        longParagraph.trim(),
        "",
        longParagraph.trim(),
        "",
        longParagraph.trim(),
      ].join("\n");

      const chunker = makeChunker({ strategy: "paragraph", maxChunkSize: 300, overlapSize: 0 });
      const chunks = chunkOk(chunker, content);

      expect(chunks.length).toBeGreaterThan(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Chunk metadata
  // ---------------------------------------------------------------------------

  describe("chunk metadata", () => {
    test("counts words correctly", () => {
      const content = "# Title\n\nOne two three four five.";
      const chunks = chunkOk(makeChunker(), content);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].metadata.wordCount).toBeGreaterThan(0);
    });

    test("detects code blocks", () => {
      const content = [
        "# Code Example",
        "",
        "Here is some code:",
        "",
        "```typescript",
        "const x = 1;",
        "```",
      ].join("\n");

      const chunks = chunkOk(makeChunker(), content);
      const codeChunk = chunks.find((c) => c.content.includes("```typescript"));
      expect(codeChunk).toBeDefined();
      expect(codeChunk!.metadata.hasCode).toBe(true);
    });

    test("detects inline code", () => {
      const content = "# Inline\n\nUse `console.log` for debugging.";
      const chunks = chunkOk(makeChunker(), content);

      expect(chunks[0].metadata.hasCode).toBe(true);
    });

    test("detects markdown links", () => {
      const content = "# Links\n\nVisit [Google](https://google.com) for more.";
      const chunks = chunkOk(makeChunker(), content);

      expect(chunks[0].metadata.hasLinks).toBe(true);
    });

    test("detects bare URLs", () => {
      const content = "# URLs\n\nCheck out https://example.com for details.";
      const chunks = chunkOk(makeChunker(), content);

      expect(chunks[0].metadata.hasLinks).toBe(true);
    });

    test("reports no code or links when absent", () => {
      const content = "# Plain\n\nJust plain text with no special formatting.";
      const chunks = chunkOk(makeChunker(), content);

      expect(chunks[0].metadata.hasCode).toBe(false);
      expect(chunks[0].metadata.hasLinks).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Deterministic IDs
  // ---------------------------------------------------------------------------

  describe("deterministic chunk IDs", () => {
    test("same input produces same IDs", () => {
      const content = "# Hello\n\nWorld.";
      const chunker = makeChunker();

      const chunks1 = chunkOk(chunker, content, "test.md", "src-1");
      const chunks2 = chunkOk(chunker, content, "test.md", "src-1");

      expect(chunks1.length).toBe(chunks2.length);
      for (let i = 0; i < chunks1.length; i++) {
        expect(chunks1[i].id).toBe(chunks2[i].id);
      }
    });

    test("different paths produce different IDs", () => {
      const content = "# Hello\n\nWorld.";
      const chunker = makeChunker();

      const chunks1 = chunkOk(chunker, content, "a.md", "src-1");
      const chunks2 = chunkOk(chunker, content, "b.md", "src-1");

      expect(chunks1[0].id).not.toBe(chunks2[0].id);
    });

    test("different content produces different IDs", () => {
      const chunker = makeChunker();

      const chunks1 = chunkOk(chunker, "# A\n\nContent A.", "doc.md", "src-1");
      const chunks2 = chunkOk(chunker, "# B\n\nContent B.", "doc.md", "src-1");

      expect(chunks1[0].id).not.toBe(chunks2[0].id);
    });

    test("generateChunkId is deterministic", () => {
      const chunker = makeChunker();
      const id1 = chunker.generateChunkId("path.md", 0, "abc123");
      const id2 = chunker.generateChunkId("path.md", 0, "abc123");

      expect(id1).toBe(id2);
      expect(id1.length).toBe(16);
    });

    test("chunk IDs are 16-character hex strings", () => {
      const content = "# Test\n\nSome content.";
      const chunks = chunkOk(makeChunker(), content);

      for (const chunk of chunks) {
        expect(chunk.id).toMatch(/^[0-9a-f]{16}$/);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe("edge cases", () => {
    test("empty document returns empty array", () => {
      const chunks = chunkOk(makeChunker(), "");
      expect(chunks).toEqual([]);
    });

    test("document with no headings produces a single chunk", () => {
      const content = "Just some plain text without any headings at all.";
      const chunks = chunkOk(makeChunker(), content);

      expect(chunks.length).toBe(1);
      expect(chunks[0].heading).toBeNull();
      expect(chunks[0].headingHierarchy).toEqual([]);
      expect(chunks[0].content).toBe(content);
    });

    test("document with only code blocks", () => {
      const content = [
        "```javascript",
        "function hello() {",
        "  console.log('hello');",
        "}",
        "```",
        "",
        "```python",
        "def hello():",
        "    print('hello')",
        "```",
      ].join("\n");

      const chunks = chunkOk(makeChunker(), content);

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      expect(chunks[0].metadata.hasCode).toBe(true);
    });

    test("single-heading document", () => {
      const content = "# Only Heading\n\nSome content under the only heading.";
      const chunks = chunkOk(makeChunker(), content);

      expect(chunks.length).toBe(1);
      expect(chunks[0].heading).toBe("# Only Heading");
      expect(chunks[0].headingHierarchy).toEqual(["# Only Heading"]);
    });

    test("whitespace-only document returns empty array", () => {
      const chunks = chunkOk(makeChunker(), "   \n\n   \n  ");
      // Content is non-empty string but sections may be empty after trim
      // The chunker receives non-empty content, so it processes it
      // but sections with only whitespace are filtered out
      expect(chunks.length).toBe(0);
    });

    test("preserves sourcePath and sourceId on all chunks", () => {
      const content = "# A\n\nText A.\n\n# B\n\nText B.";
      const chunks = chunkOk(makeChunker({ overlapSize: 0 }), content, "/docs/guide.md", "source-42");

      for (const chunk of chunks) {
        expect(chunk.sourcePath).toBe("/docs/guide.md");
        expect(chunk.sourceId).toBe("source-42");
      }
    });

    test("chunkIndex is sequential and totalChunks is correct", () => {
      const content = [
        "# A",
        "",
        "Content A.",
        "",
        "# B",
        "",
        "Content B.",
        "",
        "# C",
        "",
        "Content C.",
      ].join("\n");

      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, content);

      expect(chunks.length).toBe(3);
      for (let i = 0; i < chunks.length; i++) {
        expect(chunks[i].chunkIndex).toBe(i);
        expect(chunks[i].totalChunks).toBe(3);
      }
    });

    test("handles deeply nested headings (h1 through h4)", () => {
      const content = [
        "# Level 1",
        "",
        "L1 content.",
        "",
        "## Level 2",
        "",
        "L2 content.",
        "",
        "### Level 3",
        "",
        "L3 content.",
        "",
        "#### Level 4",
        "",
        "L4 content.",
      ].join("\n");

      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, content);

      const l4Chunk = chunks.find((c) => c.content.includes("L4 content"));
      expect(l4Chunk).toBeDefined();
      expect(l4Chunk!.headingHierarchy).toEqual([
        "# Level 1",
        "## Level 2",
        "### Level 3",
        "#### Level 4",
      ]);
    });

    test("heading hierarchy resets when a higher-level heading appears", () => {
      const content = [
        "# Part 1",
        "",
        "## Sub 1.1",
        "",
        "Content 1.1.",
        "",
        "# Part 2",
        "",
        "## Sub 2.1",
        "",
        "Content 2.1.",
      ].join("\n");

      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, content);

      const sub21 = chunks.find((c) => c.content.includes("Content 2.1"));
      expect(sub21).toBeDefined();
      expect(sub21!.headingHierarchy).toEqual(["# Part 2", "## Sub 2.1"]);
    });
  });

  // ---------------------------------------------------------------------------
  // Config defaults
  // ---------------------------------------------------------------------------

  describe("configuration", () => {
    test("DEFAULT_CHUNKING_CONFIG has expected values", () => {
      expect(DEFAULT_CHUNKING_CONFIG.strategy).toBe("heading");
      expect(DEFAULT_CHUNKING_CONFIG.maxChunkSize).toBe(1000);
      expect(DEFAULT_CHUNKING_CONFIG.minChunkSize).toBe(100);
      expect(DEFAULT_CHUNKING_CONFIG.overlapSize).toBe(100);
      expect(DEFAULT_CHUNKING_CONFIG.respectHeadings).toBe(true);
    });

    test("partial config merges with defaults", () => {
      const chunker = makeChunker({ maxChunkSize: 500 });
      const content = "# Test\n\nContent.";
      const chunks = chunkOk(chunker, content);

      // Should work with merged config
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ---------------------------------------------------------------------------
  // ChunkingError
  // ---------------------------------------------------------------------------

  describe("ChunkingError", () => {
    test("extends ReinsError with CHUNKING_ERROR code", () => {
      const error = new ChunkingError("test error");
      expect(error.code).toBe("CHUNKING_ERROR");
      expect(error.name).toBe("ChunkingError");
      expect(error.message).toBe("test error");
    });
  });

  // ---------------------------------------------------------------------------
  // Realistic document
  // ---------------------------------------------------------------------------

  describe("realistic markdown document", () => {
    const realisticDoc = [
      "# Project Setup Guide",
      "",
      "This guide walks you through setting up the project from scratch.",
      "",
      "## Prerequisites",
      "",
      "Before you begin, make sure you have:",
      "",
      "- Node.js 18 or later",
      "- Git installed",
      "- A GitHub account",
      "",
      "## Installation",
      "",
      "### Clone the Repository",
      "",
      "```bash",
      "git clone https://github.com/example/project.git",
      "cd project",
      "```",
      "",
      "### Install Dependencies",
      "",
      "Run the following command:",
      "",
      "```bash",
      "npm install",
      "```",
      "",
      "## Configuration",
      "",
      "Create a `.env` file with the following variables:",
      "",
      "```",
      "DATABASE_URL=postgres://localhost:5432/mydb",
      "API_KEY=your-api-key",
      "```",
      "",
      "See the [configuration docs](https://example.com/docs/config) for more details.",
      "",
      "## Running Tests",
      "",
      "```bash",
      "npm test",
      "```",
      "",
      "All tests should pass before submitting a PR.",
    ].join("\n");

    test("produces multiple chunks from realistic document", () => {
      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, realisticDoc, "docs/setup.md", "docs-src");

      expect(chunks.length).toBeGreaterThanOrEqual(4);
    });

    test("code blocks are detected in realistic chunks", () => {
      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, realisticDoc);

      const installChunk = chunks.find((c) => c.content.includes("git clone"));
      expect(installChunk).toBeDefined();
      expect(installChunk!.metadata.hasCode).toBe(true);
    });

    test("links are detected in realistic chunks", () => {
      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, realisticDoc);

      const configChunk = chunks.find((c) => c.content.includes("configuration docs"));
      expect(configChunk).toBeDefined();
      expect(configChunk!.metadata.hasLinks).toBe(true);
    });

    test("all chunks have valid offsets", () => {
      const chunker = makeChunker({ overlapSize: 0 });
      const chunks = chunkOk(chunker, realisticDoc);

      for (const chunk of chunks) {
        expect(chunk.startOffset).toBeGreaterThanOrEqual(0);
        expect(chunk.endOffset).toBeGreaterThan(chunk.startOffset);
        expect(chunk.startOffset).toBeLessThan(realisticDoc.length);
      }
    });
  });
});
