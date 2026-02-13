import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { executeWrite } from "../../src/tools/system/write";
import { SystemToolExecutionError } from "../../src/tools/system/types";

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "reins-write-"));
}

describe("executeWrite", () => {
  it("writes a new file successfully", async () => {
    const sandbox = makeSandbox();

    try {
      const result = await executeWrite(
        { path: "hello.txt", content: "Hello, world!" },
        sandbox,
      );

      expect(result.title).toContain("hello.txt");
      expect(result.output).toContain("Successfully wrote");
      expect(result.metadata.truncated).toBe(false);
      expect(result.metadata.bytesWritten).toBe(13);
      expect(result.metadata.byteCount).toBe(13);

      const written = readFileSync(join(sandbox, "hello.txt"), "utf-8");
      expect(written).toBe("Hello, world!");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("overwrites an existing file", async () => {
    const sandbox = makeSandbox();

    try {
      writeFileSync(join(sandbox, "existing.txt"), "old content");

      const result = await executeWrite(
        { path: "existing.txt", content: "new content" },
        sandbox,
      );

      expect(result.output).toContain("Successfully wrote");

      const written = readFileSync(join(sandbox, "existing.txt"), "utf-8");
      expect(written).toBe("new content");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("creates parent directories when they do not exist", async () => {
    const sandbox = makeSandbox();

    try {
      const result = await executeWrite(
        { path: "deep/nested/dir/file.ts", content: "export const x = 1;\n" },
        sandbox,
      );

      expect(result.output).toContain("Successfully wrote");
      expect(existsSync(join(sandbox, "deep/nested/dir/file.ts"))).toBe(true);

      const written = readFileSync(join(sandbox, "deep/nested/dir/file.ts"), "utf-8");
      expect(written).toBe("export const x = 1;\n");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects paths outside sandbox", async () => {
    const sandbox = makeSandbox();

    try {
      await executeWrite(
        { path: "../../../etc/evil.txt", content: "bad" },
        sandbox,
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_PERMISSION_DENIED");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths outside sandbox", async () => {
    const sandbox = makeSandbox();

    try {
      await executeWrite(
        { path: "/tmp/outside-sandbox.txt", content: "bad" },
        sandbox,
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_PERMISSION_DENIED");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("returns proper metadata with path and bytes", async () => {
    const sandbox = makeSandbox();
    const content = "line one\nline two\nline three\n";

    try {
      const result = await executeWrite(
        { path: "meta.txt", content },
        sandbox,
      );

      const expectedBytes = new TextEncoder().encode(content).byteLength;
      expect(result.metadata.byteCount).toBe(expectedBytes);
      expect(result.metadata.bytesWritten).toBe(expectedBytes);
      expect(result.metadata.lineCount).toBe(4);
      expect(result.metadata.path).toContain("meta.txt");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("handles empty content", async () => {
    const sandbox = makeSandbox();

    try {
      const result = await executeWrite(
        { path: "empty.txt", content: "" },
        sandbox,
      );

      expect(result.metadata.byteCount).toBe(0);
      expect(result.metadata.lineCount).toBe(0);

      const written = readFileSync(join(sandbox, "empty.txt"), "utf-8");
      expect(written).toBe("");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("throws validation error for missing path argument", async () => {
    const sandbox = makeSandbox();

    try {
      await executeWrite({ content: "hello" }, sandbox);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_VALIDATION_FAILED");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("throws validation error for missing content argument", async () => {
    const sandbox = makeSandbox();

    try {
      await executeWrite({ path: "file.txt" }, sandbox);
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_VALIDATION_FAILED");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("handles multi-byte UTF-8 content correctly", async () => {
    const sandbox = makeSandbox();
    const content = "Hello \u{1F600} World \u{1F30D}";

    try {
      const result = await executeWrite(
        { path: "unicode.txt", content },
        sandbox,
      );

      const expectedBytes = new TextEncoder().encode(content).byteLength;
      expect(result.metadata.byteCount).toBe(expectedBytes);

      const written = readFileSync(join(sandbox, "unicode.txt"), "utf-8");
      expect(written).toBe(content);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
