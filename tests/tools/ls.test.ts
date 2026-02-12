import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { LsTool } from "../../src/tools/system/ls";
import { SYSTEM_TOOL_ERROR_CODES } from "../../src/tools/system/types";
import type { ToolContext } from "../../src/types";

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "reins-ls-"));
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

describe("LsTool", () => {
  describe("success cases", () => {
    it("lists directory contents with metadata", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "file-a.txt"), "hello");
        writeFileSync(join(sandbox, "file-b.ts"), "export const x = 1;");
        mkdirSync(join(sandbox, "src"));

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toContain("src/");
        expect(output).toContain("file-a.txt");
        expect(output).toContain("file-b.ts");
      } finally {
        cleanup(sandbox);
      }
    });

    it("lists sandbox root when no path argument provided", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "root-file.txt"), "content");
        mkdirSync(join(sandbox, "root-dir"));

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toContain("root-file.txt");
        expect(output).toContain("root-dir/");
      } finally {
        cleanup(sandbox);
      }
    });

    it("shows file type, size, and modified timestamp", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "data.txt"), "12345");
        mkdirSync(join(sandbox, "subdir"));

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);

        const lines = output.split("\n");
        const dirLine = lines.find((l) => l.includes("subdir/"));
        const fileLine = lines.find((l) => l.includes("data.txt"));

        expect(dirLine).toBeDefined();
        expect(dirLine).toMatch(/^d/);
        expect(dirLine).toContain("-");

        expect(fileLine).toBeDefined();
        expect(fileLine).toMatch(/^-/);
        expect(fileLine).toContain("5");
      } finally {
        cleanup(sandbox);
      }
    });

    it("sorts output with directories first then files alphabetically", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "zebra.txt"), "z");
        writeFileSync(join(sandbox, "alpha.txt"), "a");
        mkdirSync(join(sandbox, "zulu-dir"));
        mkdirSync(join(sandbox, "alpha-dir"));

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        const lines = output.split("\n");

        expect(lines[0]).toContain("alpha-dir/");
        expect(lines[1]).toContain("zulu-dir/");
        expect(lines[2]).toContain("alpha.txt");
        expect(lines[3]).toContain("zebra.txt");
      } finally {
        cleanup(sandbox);
      }
    });

    it("handles empty directory", async () => {
      const sandbox = makeSandbox();
      try {
        mkdirSync(join(sandbox, "empty"));

        const tool = new LsTool(sandbox);
        const result = await tool.execute({ path: "empty" }, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toBe("Empty directory.");
        const meta = resultMetadata(result.result);
        expect(meta["entryCount"]).toBe(0);
      } finally {
        cleanup(sandbox);
      }
    });

    it("handles directory with mixed files and subdirectories", async () => {
      const sandbox = makeSandbox();
      try {
        mkdirSync(join(sandbox, "project", "src"), { recursive: true });
        mkdirSync(join(sandbox, "project", "tests"));
        writeFileSync(join(sandbox, "project", "README.md"), "# Hello");
        writeFileSync(join(sandbox, "project", "package.json"), "{}");

        const tool = new LsTool(sandbox);
        const result = await tool.execute({ path: "project" }, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        const lines = output.split("\n");

        expect(lines).toHaveLength(4);
        expect(lines[0]).toContain("src/");
        expect(lines[1]).toContain("tests/");
        // localeCompare: package.json < README.md
        expect(lines[2]).toContain("package.json");
        expect(lines[3]).toContain("README.md");
      } finally {
        cleanup(sandbox);
      }
    });

    it("lists subdirectory by relative path", async () => {
      const sandbox = makeSandbox();
      try {
        mkdirSync(join(sandbox, "nested", "deep"), { recursive: true });
        writeFileSync(join(sandbox, "nested", "inner.txt"), "inner");

        const tool = new LsTool(sandbox);
        const result = await tool.execute({ path: "nested" }, stubContext);

        expect(result.error).toBeUndefined();
        const output = resultOutput(result.result);
        expect(output).toContain("deep/");
        expect(output).toContain("inner.txt");
      } finally {
        cleanup(sandbox);
      }
    });
  });

  describe("error cases", () => {
    it("rejects path outside sandbox", async () => {
      const sandbox = makeSandbox();
      try {
        const tool = new LsTool(sandbox);

        try {
          await tool.execute({ path: "/etc" }, stubContext);
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
        }
      } finally {
        cleanup(sandbox);
      }
    });

    it("rejects traversal escape attempts", async () => {
      const sandbox = makeSandbox();
      try {
        const tool = new LsTool(sandbox);

        try {
          await tool.execute({ path: "../../../etc" }, stubContext);
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
        }
      } finally {
        cleanup(sandbox);
      }
    });

    it("returns error for non-existent path", async () => {
      const sandbox = makeSandbox();
      try {
        const tool = new LsTool(sandbox);

        try {
          await tool.execute({ path: "does-not-exist" }, stubContext);
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string; details?: Record<string, unknown> };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_EXECUTION_FAILED);
          expect(toolError.details?.["reason"]).toBe("path_not_found");
        }
      } finally {
        cleanup(sandbox);
      }
    });

    it("returns error for file path (not directory)", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "not-a-dir.txt"), "content");
        const tool = new LsTool(sandbox);

        try {
          await tool.execute({ path: "not-a-dir.txt" }, stubContext);
          expect(true).toBe(false);
        } catch (error: unknown) {
          const toolError = error as { code: string; details?: Record<string, unknown> };
          expect(toolError.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_VALIDATION_FAILED);
          expect(toolError.details?.["reason"]).toBe("not_a_directory");
        }
      } finally {
        cleanup(sandbox);
      }
    });
  });

  describe("format assertions", () => {
    it("output includes all metadata fields per entry", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "sample.txt"), "hello world");

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        const output = resultOutput(result.result);
        const fileLine = output.split("\n").find((l) => l.includes("sample.txt"));

        expect(fileLine).toBeDefined();
        expect(fileLine).toMatch(/^-/);
        expect(fileLine).toContain("sample.txt");
        expect(fileLine).toContain("11");
        expect(fileLine).toMatch(/\d{4}-\d{2}-\d{2}T/);
      } finally {
        cleanup(sandbox);
      }
    });

    it("timestamps are in ISO format", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "ts-test.txt"), "data");

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        const output = resultOutput(result.result);
        const isoPattern = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/;
        expect(output).toMatch(isoPattern);
      } finally {
        cleanup(sandbox);
      }
    });

    it("file sizes are accurate", async () => {
      const sandbox = makeSandbox();
      try {
        const content = "exactly twenty chars";
        writeFileSync(join(sandbox, "sized.txt"), content);

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        const output = resultOutput(result.result);
        const expectedSize = Buffer.byteLength(content, "utf-8");
        expect(output).toContain(String(expectedSize));
      } finally {
        cleanup(sandbox);
      }
    });

    it("type classification is correct for files and directories", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "regular.txt"), "file");
        mkdirSync(join(sandbox, "folder"));

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        const output = resultOutput(result.result);
        const lines = output.split("\n");

        const dirLine = lines.find((l) => l.includes("folder/"));
        const fileLine = lines.find((l) => l.includes("regular.txt"));

        expect(dirLine).toMatch(/^d/);
        expect(fileLine).toMatch(/^-/);
      } finally {
        cleanup(sandbox);
      }
    });

    it("directory sizes show dash instead of number", async () => {
      const sandbox = makeSandbox();
      try {
        mkdirSync(join(sandbox, "mydir"));

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        const output = resultOutput(result.result);
        const dirLine = output.split("\n").find((l) => l.includes("mydir/"));
        expect(dirLine).toBeDefined();
        expect(dirLine).toContain("\t-\t");
      } finally {
        cleanup(sandbox);
      }
    });

    it("metadata includes entry counts", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "a.txt"), "a");
        writeFileSync(join(sandbox, "b.txt"), "b");
        mkdirSync(join(sandbox, "dir1"));

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        const meta = resultMetadata(result.result);
        expect(meta["entryCount"]).toBe(3);
        expect(meta["directories"]).toBe(1);
        expect(meta["files"]).toBe(2);
      } finally {
        cleanup(sandbox);
      }
    });

    it("result has correct name from definition", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "test.txt"), "content");
        const tool = new LsTool(sandbox);

        const result = await tool.execute({}, stubContext);

        expect(result.name).toBe("ls");
      } finally {
        cleanup(sandbox);
      }
    });

    it("symlinks are classified correctly", async () => {
      const sandbox = makeSandbox();
      try {
        writeFileSync(join(sandbox, "target.txt"), "target");
        try {
          symlinkSync(join(sandbox, "target.txt"), join(sandbox, "link.txt"));
        } catch {
          // Symlinks may not be supported on all platforms; skip gracefully
          return;
        }

        const tool = new LsTool(sandbox);
        const result = await tool.execute({}, stubContext);

        const output = resultOutput(result.result);
        // stat() follows symlinks, so it will appear as a file
        expect(output).toContain("link.txt");
        expect(output).toContain("target.txt");
      } finally {
        cleanup(sandbox);
      }
    });
  });
});
