import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "bun:test";

import { executeEdit } from "../../src/tools/system/edit";
import { SystemToolExecutionError } from "../../src/tools/system/types";

function makeSandbox(): string {
  return mkdtempSync(join(tmpdir(), "reins-edit-"));
}

function writeTestFile(sandbox: string, name: string, content: string): string {
  const filePath = join(sandbox, name);
  writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("executeEdit", () => {
  it("replaces a single occurrence successfully", async () => {
    const sandbox = makeSandbox();

    try {
      writeTestFile(sandbox, "file.ts", 'const name = "old";\n');

      const result = await executeEdit(
        { path: "file.ts", oldString: '"old"', newString: '"new"' },
        sandbox,
      );

      expect(result.title).toContain("file.ts");
      expect(result.title).toContain("line 1");
      expect(result.metadata.lineNumber).toBe(1);

      const updated = readFileSync(join(sandbox, "file.ts"), "utf-8");
      expect(updated).toBe('const name = "new";\n');
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("returns diff-like output with context", async () => {
    const sandbox = makeSandbox();
    const content = [
      "line 1",
      "line 2",
      "line 3",
      "const target = true;",
      "line 5",
      "line 6",
      "line 7",
    ].join("\n");

    try {
      writeTestFile(sandbox, "diff.ts", content);

      const result = await executeEdit(
        { path: "diff.ts", oldString: "const target = true;", newString: "const target = false;" },
        sandbox,
      );

      expect(result.output).toContain("-const target = true;");
      expect(result.output).toContain("+const target = false;");
      expect(result.output).toContain("@@");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("errors on string not found (0 matches)", async () => {
    const sandbox = makeSandbox();

    try {
      writeTestFile(sandbox, "nope.ts", "const x = 1;\n");

      await executeEdit(
        { path: "nope.ts", oldString: "nonexistent", newString: "replacement" },
        sandbox,
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_EXECUTION_FAILED");
      expect(toolError.message).toContain("not found");
      expect(toolError.details?.["reason"]).toBe("string_not_found");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("errors on ambiguous match (2+ matches)", async () => {
    const sandbox = makeSandbox();

    try {
      writeTestFile(sandbox, "ambiguous.ts", "foo bar foo baz foo\n");

      await executeEdit(
        { path: "ambiguous.ts", oldString: "foo", newString: "qux" },
        sandbox,
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_VALIDATION_FAILED");
      expect(toolError.message).toContain("Ambiguous");
      expect(toolError.details?.["reason"]).toBe("ambiguous_match");
      expect(toolError.details?.["count"]).toBe(3);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("rejects paths outside sandbox", async () => {
    const sandbox = makeSandbox();

    try {
      await executeEdit(
        { path: "../../../etc/passwd", oldString: "root", newString: "hacked" },
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

  it("handles multi-line content replacement", async () => {
    const sandbox = makeSandbox();
    const content = [
      "function hello() {",
      "  console.log('hello');",
      "}",
      "",
      "function world() {",
      "  console.log('world');",
      "}",
    ].join("\n");

    try {
      writeTestFile(sandbox, "multi.ts", content);

      const oldBlock = "function hello() {\n  console.log('hello');\n}";
      const newBlock = "function hello() {\n  console.log('hi there');\n  return true;\n}";

      const result = await executeEdit(
        { path: "multi.ts", oldString: oldBlock, newString: newBlock },
        sandbox,
      );

      expect(result.metadata.lineNumber).toBe(1);

      const updated = readFileSync(join(sandbox, "multi.ts"), "utf-8");
      expect(updated).toContain("console.log('hi there')");
      expect(updated).toContain("return true;");
      expect(updated).toContain("console.log('world')");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("performs case-sensitive matching", async () => {
    const sandbox = makeSandbox();

    try {
      writeTestFile(sandbox, "case.ts", "const Hello = 'hello';\n");

      await executeEdit(
        { path: "case.ts", oldString: "hello", newString: "world" },
        sandbox,
      );

      const updated = readFileSync(join(sandbox, "case.ts"), "utf-8");
      expect(updated).toBe("const Hello = 'world';\n");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("case-sensitive: uppercase search does not match lowercase", async () => {
    const sandbox = makeSandbox();

    try {
      writeTestFile(sandbox, "case2.ts", "const hello = 'world';\n");

      await executeEdit(
        { path: "case2.ts", oldString: "Hello", newString: "Goodbye" },
        sandbox,
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_EXECUTION_FAILED");
      expect(toolError.details?.["reason"]).toBe("string_not_found");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("errors when file does not exist", async () => {
    const sandbox = makeSandbox();

    try {
      await executeEdit(
        { path: "missing.ts", oldString: "foo", newString: "bar" },
        sandbox,
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_EXECUTION_FAILED");
      expect(toolError.message).toContain("not found");
      expect(toolError.details?.["reason"]).toBe("file_not_found");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("returns correct metadata after edit", async () => {
    const sandbox = makeSandbox();

    try {
      writeTestFile(sandbox, "meta.ts", "aaa\nbbb\nccc\n");

      const result = await executeEdit(
        { path: "meta.ts", oldString: "bbb", newString: "BBB" },
        sandbox,
      );

      expect(result.metadata.lineNumber).toBe(2);
      expect(result.metadata.replacedLength).toBe(3);
      expect(result.metadata.insertedLength).toBe(3);
      expect(result.metadata.path).toContain("meta.ts");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("throws validation error for missing path argument", async () => {
    const sandbox = makeSandbox();

    try {
      await executeEdit(
        { oldString: "foo", newString: "bar" },
        sandbox,
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_VALIDATION_FAILED");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("throws validation error for missing oldString argument", async () => {
    const sandbox = makeSandbox();

    try {
      writeTestFile(sandbox, "val.ts", "content\n");

      await executeEdit(
        { path: "val.ts", newString: "bar" },
        sandbox,
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_VALIDATION_FAILED");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("handles empty oldString as zero matches", async () => {
    const sandbox = makeSandbox();

    try {
      writeTestFile(sandbox, "empty.ts", "some content\n");

      await executeEdit(
        { path: "empty.ts", oldString: "", newString: "inserted" },
        sandbox,
      );
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_EXECUTION_FAILED");
      expect(toolError.details?.["reason"]).toBe("string_not_found");
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it("handles replacement that changes line count", async () => {
    const sandbox = makeSandbox();

    try {
      writeTestFile(sandbox, "lines.ts", "one\ntwo\nthree\n");

      const result = await executeEdit(
        { path: "lines.ts", oldString: "two", newString: "two-a\ntwo-b\ntwo-c" },
        sandbox,
      );

      const updated = readFileSync(join(sandbox, "lines.ts"), "utf-8");
      expect(updated).toBe("one\ntwo-a\ntwo-b\ntwo-c\nthree\n");
      expect(result.metadata.replacedLength).toBe(3);
      expect(result.metadata.insertedLength).toBe(17);
    } finally {
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
