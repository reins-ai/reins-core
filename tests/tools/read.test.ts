import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { ReadTool } from "../../src/tools/system/read";
import { SYSTEM_TOOL_ERROR_CODES } from "../../src/tools/system/types";
import type { ToolContext } from "../../src/types";

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "reins-read-"));
}

function cleanup(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

const stubContext: ToolContext = {
  conversationId: "test-conv",
  userId: "test-user",
};

function resultOutput(result: unknown): string {
  const sys = result as { output: string };
  return sys.output;
}

function resultMetadata(result: unknown): Record<string, unknown> {
  const sys = result as { metadata: Record<string, unknown> };
  return sys.metadata;
}

describe("ReadTool", () => {
  describe("success cases", () => {
    it("reads entire file with no offset or limit", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "hello.txt"), "line one\nline two\nline three");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute({ path: "hello.txt" }, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toContain("1: line one");
        expect(output).toContain("2: line two");
        expect(output).toContain("3: line three");
      } finally {
        cleanup(sandbox);
      }
    });

    it("reads with offset to skip first N lines", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(
          join(sandbox, "data.txt"),
          "alpha\nbeta\ngamma\ndelta\nepsilon",
        );
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "data.txt", offset: 3 },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toContain("3: gamma");
        expect(output).toContain("4: delta");
        expect(output).toContain("5: epsilon");
        expect(output).not.toContain("1: alpha");
        expect(output).not.toContain("2: beta");
      } finally {
        cleanup(sandbox);
      }
    });

    it("reads with limit to cap returned lines", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(
          join(sandbox, "data.txt"),
          "one\ntwo\nthree\nfour\nfive",
        );
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "data.txt", limit: 2 },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toContain("1: one");
        expect(output).toContain("2: two");
        expect(output).not.toContain("3: three");
      } finally {
        cleanup(sandbox);
      }
    });

    it("reads with offset and limit combined", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(
          join(sandbox, "data.txt"),
          "a\nb\nc\nd\ne\nf\ng",
        );
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "data.txt", offset: 3, limit: 2 },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toBe("3: c\n4: d");
      } finally {
        cleanup(sandbox);
      }
    });

    it("returns 1-based line numbers starting from offset", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(
          join(sandbox, "numbered.txt"),
          "first\nsecond\nthird\nfourth\nfifth",
        );
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "numbered.txt", offset: 4 },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        const lines = output.split("\n");
        expect(lines[0]).toBe("4: fourth");
        expect(lines[1]).toBe("5: fifth");
      } finally {
        cleanup(sandbox);
      }
    });

    it("handles empty file", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "empty.txt"), "");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute({ path: "empty.txt" }, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toBe("");
        const meta = resultMetadata(result.result);
        expect(meta["lineCount"]).toBe(0);
      } finally {
        cleanup(sandbox);
      }
    });

    it("handles single-line file", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "single.txt"), "only line");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute({ path: "single.txt" }, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toBe("1: only line");
        const meta = resultMetadata(result.result);
        expect(meta["lineCount"]).toBe(1);
      } finally {
        cleanup(sandbox);
      }
    });

    it("reads files in nested directories", async () => {
      const sandbox = makeSandbox();
      try {
        mkdirSync(join(sandbox, "src", "tools"), { recursive: true });
        writeFileSync(join(sandbox, "src", "tools", "deep.ts"), "export const x = 1;");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "src/tools/deep.ts" },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toBe("1: export const x = 1;");
      } finally {
        cleanup(sandbox);
      }
    });

    it("handles unicode content correctly", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(
          join(sandbox, "unicode.txt"),
          "Hello \u{1F600}\nCaf\u00E9\n\u4F60\u597D\u4E16\u754C",
        );
        const tool = new ReadTool(sandbox);

        const result = await tool.execute({ path: "unicode.txt" }, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toContain("1: Hello \u{1F600}");
        expect(output).toContain("2: Caf\u00E9");
        expect(output).toContain("3: \u4F60\u597D\u4E16\u754C");
      } finally {
        cleanup(sandbox);
      }
    });
  });

  describe("error cases", () => {
    it("rejects path outside sandbox", async () => {
      const sandbox = makeSandbox();
      try {
        const tool = new ReadTool(sandbox);

        try {
          await tool.execute({ path: "/etc/passwd" }, stubContext);
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string; details?: Record<string, unknown> };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
        }
      } finally {
        cleanup(sandbox);
      }
    });

    it("rejects traversal escape attempts", async () => {
      const sandbox = makeSandbox();
      try {
        const tool = new ReadTool(sandbox);

        try {
          await tool.execute(
            { path: "../../../etc/passwd" },
            stubContext,
          );
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
        }
      } finally {
        cleanup(sandbox);
      }
    });

    it("returns error for non-existent file", async () => {
      const sandbox = makeSandbox();
      try {
        const tool = new ReadTool(sandbox);

        try {
          await tool.execute({ path: "missing.txt" }, stubContext);
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string; details?: Record<string, unknown> };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
          expect(toolError.details?.["reason"]).toBe("file_not_found");
        }
      } finally {
        cleanup(sandbox);
      }
    });

    it("returns error for directory path", async () => {
      const sandbox = makeSandbox();
      try {
        mkdirSync(join(sandbox, "subdir"));
        const tool = new ReadTool(sandbox);

        try {
          await tool.execute({ path: "subdir" }, stubContext);
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string; details?: Record<string, unknown> };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
          expect(toolError.details?.["reason"]).toBe("is_directory");
        }
      } finally {
        cleanup(sandbox);
      }
    });

    it("rejects missing path argument", async () => {
      const sandbox = makeSandbox();
      try {
        const tool = new ReadTool(sandbox);

        try {
          await tool.execute({}, stubContext);
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_VALIDATION_FAILED);
        }
      } finally {
        cleanup(sandbox);
      }
    });

    it("rejects empty string path", async () => {
      const sandbox = makeSandbox();
      try {
        const tool = new ReadTool(sandbox);

        try {
          await tool.execute({ path: "  " }, stubContext);
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_VALIDATION_FAILED);
        }
      } finally {
        cleanup(sandbox);
      }
    });
  });

  describe("edge cases", () => {
    it("returns empty output when offset is beyond file length", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "short.txt"), "one\ntwo\nthree");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "short.txt", offset: 100 },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toBe("");
        const meta = resultMetadata(result.result);
        expect(meta["lineCount"]).toBe(0);
      } finally {
        cleanup(sandbox);
      }
    });

    it("returns all remaining lines when limit exceeds remaining", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "short.txt"), "one\ntwo\nthree");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "short.txt", limit: 10000 },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        const lines = output.split("\n");
        expect(lines).toHaveLength(3);
        expect(lines[0]).toBe("1: one");
        expect(lines[1]).toBe("2: two");
        expect(lines[2]).toBe("3: three");
      } finally {
        cleanup(sandbox);
      }
    });

    it("triggers truncation for large output", async () => {
      const sandbox = makeSandbox();
      try {
        const manyLines = Array.from(
          { length: 3000 },
          (_, i) => `Line content number ${i + 1}`,
        ).join("\n");
        writeFileSync(join(sandbox, "large.txt"), manyLines);
        const tool = new ReadTool(sandbox);

        const result = await tool.execute({ path: "large.txt" }, stubContext);

        expect(result.error).toBeUndefined();
        const meta = resultMetadata(result.result);
        // Default limit is 2000 lines, so we get at most 2000 lines
        // but truncateOutput may further truncate by byte count
        expect(meta["lineCount"]).toBeLessThanOrEqual(2000);
        expect(meta["totalLines"]).toBe(3000);
      } finally {
        cleanup(sandbox);
      }
    });

    it("sets truncated metadata when output is truncated", async () => {
      const sandbox = makeSandbox();
      try {
        // Create content that exceeds byte limit (50KB)
        const longLine = "x".repeat(200);
        const manyLines = Array.from(
          { length: 2500 },
          () => longLine,
        ).join("\n");
        writeFileSync(join(sandbox, "huge.txt"), manyLines);
        const tool = new ReadTool(sandbox);

        const result = await tool.execute({ path: "huge.txt" }, stubContext);

        expect(result.error).toBeUndefined();
        const meta = resultMetadata(result.result);
        expect(meta["truncated"]).toBe(true);
      } finally {
        cleanup(sandbox);
      }
    });

    it("defaults invalid offset to 1", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "data.txt"), "first\nsecond");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "data.txt", offset: -5 },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toContain("1: first");
        const meta = resultMetadata(result.result);
        expect(meta["offset"]).toBe(1);
      } finally {
        cleanup(sandbox);
      }
    });

    it("defaults invalid limit to 2000", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "data.txt"), "first\nsecond");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "data.txt", limit: 0 },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const meta = resultMetadata(result.result);
        expect(meta["limit"]).toBe(2000);
      } finally {
        cleanup(sandbox);
      }
    });

    it("handles file ending with newline", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "trailing.txt"), "line one\nline two\n");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "trailing.txt" },
          stubContext,
        );

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        // File "line one\nline two\n" splits to ["line one", "line two", ""]
        expect(output).toContain("1: line one");
        expect(output).toContain("2: line two");
        expect(output).toContain("3: ");
        const meta = resultMetadata(result.result);
        expect(meta["totalLines"]).toBe(3);
      } finally {
        cleanup(sandbox);
      }
    });
  });

  describe("format assertions", () => {
    it("line numbers are 1-based", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "nums.txt"), "a\nb\nc");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute({ path: "nums.txt" }, stubContext);

        const output = resultOutput(result.result);
        const lines = output.split("\n");
        expect(lines[0]).toStartWith("1: ");
        expect(lines[1]).toStartWith("2: ");
        expect(lines[2]).toStartWith("3: ");
      } finally {
        cleanup(sandbox);
      }
    });

    it("line numbers match offset when offset is provided", async () => {
      const sandbox = makeSandbox();
      try {
        const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n");
        writeFileSync(join(sandbox, "many.txt"), content);
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "many.txt", offset: 10, limit: 3 },
          stubContext,
        );

        const output = resultOutput(result.result);
        const lines = output.split("\n");
        expect(lines[0]).toBe("10: line 10");
        expect(lines[1]).toBe("11: line 11");
        expect(lines[2]).toBe("12: line 12");
      } finally {
        cleanup(sandbox);
      }
    });

    it("metadata includes correct totalLines and lineCount", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(
          join(sandbox, "meta.txt"),
          "a\nb\nc\nd\ne\nf\ng\nh\ni\nj",
        );
        const tool = new ReadTool(sandbox);

        const result = await tool.execute(
          { path: "meta.txt", offset: 3, limit: 4 },
          stubContext,
        );

        const meta = resultMetadata(result.result);
        expect(meta["totalLines"]).toBe(10);
        expect(meta["lineCount"]).toBe(4);
        expect(meta["offset"]).toBe(3);
        expect(meta["limit"]).toBe(4);
      } finally {
        cleanup(sandbox);
      }
    });

    it("result has correct name from definition", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "test.txt"), "content");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute({ path: "test.txt" }, stubContext);

        expect(result.name).toBe("read");
      } finally {
        cleanup(sandbox);
      }
    });

    it("truncation metadata is false for small files", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "small.txt"), "just a small file");
        const tool = new ReadTool(sandbox);

        const result = await tool.execute({ path: "small.txt" }, stubContext);

        const meta = resultMetadata(result.result);
        expect(meta["truncated"]).toBe(false);
      } finally {
        cleanup(sandbox);
      }
    });
  });
});
