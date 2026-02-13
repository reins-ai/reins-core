import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { GlobTool } from "../../src/tools/system/glob";
import { SystemToolExecutionError } from "../../src/tools/system/types";

describe("GlobTool", () => {
  let sandboxRoot: string;
  let tool: GlobTool;

  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "reins-glob-"));
    tool = new GlobTool(sandboxRoot);

    mkdirSync(join(sandboxRoot, "src", "utils"), { recursive: true });
    mkdirSync(join(sandboxRoot, "src", "tools"), { recursive: true });
    mkdirSync(join(sandboxRoot, "tests"), { recursive: true });

    writeFileSync(join(sandboxRoot, "src", "index.ts"), "export {};");
    writeFileSync(join(sandboxRoot, "src", "utils", "helpers.ts"), "export {};");
    writeFileSync(join(sandboxRoot, "src", "utils", "format.ts"), "export {};");
    writeFileSync(join(sandboxRoot, "src", "tools", "runner.ts"), "export {};");
    writeFileSync(join(sandboxRoot, "tests", "helpers.test.ts"), "test();");
    writeFileSync(join(sandboxRoot, "README.md"), "# Test");
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("returns matching files for a glob pattern", async () => {
    const result = await tool.execute({ pattern: "**/*.ts" });

    expect(result.metadata.matchCount).toBeGreaterThanOrEqual(5);
    expect(result.output).toContain("src/index.ts");
    expect(result.output).toContain("src/utils/helpers.ts");
    expect(result.output).toContain("tests/helpers.test.ts");
  });

  it("returns empty list for no matches", async () => {
    const result = await tool.execute({ pattern: "**/*.xyz" });

    expect(result.output).toBe("No files matched the pattern.");
    expect(result.metadata.matchCount).toBe(0);
    expect(result.metadata.truncated).toBe(false);
  });

  it("returns sorted output alphabetically", async () => {
    const result = await tool.execute({ pattern: "src/**/*.ts" });

    const lines = result.output.split("\n");
    const sorted = [...lines].sort();
    expect(lines).toEqual(sorted);
  });

  it("respects .gitignore patterns", async () => {
    mkdirSync(join(sandboxRoot, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(sandboxRoot, "node_modules", "pkg", "index.js"), "module.exports = {};");
    mkdirSync(join(sandboxRoot, "dist"), { recursive: true });
    writeFileSync(join(sandboxRoot, "dist", "bundle.js"), "var x;");
    writeFileSync(join(sandboxRoot, ".gitignore"), "node_modules\ndist\n");

    const result = await tool.execute({ pattern: "**/*.js" });

    expect(result.output).not.toContain("node_modules");
    expect(result.output).not.toContain("dist/bundle.js");
  });

  it("respects .gitignore negation patterns", async () => {
    mkdirSync(join(sandboxRoot, "build"), { recursive: true });
    writeFileSync(join(sandboxRoot, "build", "output.js"), "var x;");
    writeFileSync(join(sandboxRoot, "build", "keep.js"), "var y;");
    writeFileSync(join(sandboxRoot, ".gitignore"), "*.js\n!keep.js\n");

    const result = await tool.execute({ pattern: "**/*.js" });

    expect(result.output).toContain("keep.js");
    expect(result.output).not.toContain("output.js");
  });

  it("rejects path outside sandbox", async () => {
    await expect(
      tool.execute({ pattern: "**/*.ts", path: "/etc" }),
    ).rejects.toBeInstanceOf(SystemToolExecutionError);

    try {
      await tool.execute({ pattern: "**/*.ts", path: "/etc" });
    } catch (error) {
      expect(error).toBeInstanceOf(SystemToolExecutionError);
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_PERMISSION_DENIED");
    }
  });

  it("handles nested directories correctly", async () => {
    mkdirSync(join(sandboxRoot, "a", "b", "c"), { recursive: true });
    writeFileSync(join(sandboxRoot, "a", "b", "c", "deep.ts"), "export {};");

    const result = await tool.execute({ pattern: "**/*.ts" });

    expect(result.output).toContain("a/b/c/deep.ts");
  });

  it("searches from a subdirectory when path is provided", async () => {
    const result = await tool.execute({ pattern: "**/*.ts", path: "src/utils" });

    const lines = result.output.split("\n");
    expect(lines.length).toBe(2);
    expect(result.output).toContain("helpers.ts");
    expect(result.output).toContain("format.ts");
  });

  it("throws validation error for empty pattern", async () => {
    await expect(
      tool.execute({ pattern: "" }),
    ).rejects.toBeInstanceOf(SystemToolExecutionError);

    try {
      await tool.execute({ pattern: "" });
    } catch (error) {
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_VALIDATION_FAILED");
    }
  });

  it("throws validation error for missing pattern", async () => {
    await expect(
      tool.execute({}),
    ).rejects.toBeInstanceOf(SystemToolExecutionError);
  });

  it("includes metadata with pattern and match count", async () => {
    const result = await tool.execute({ pattern: "**/*.ts" });

    expect(result.metadata.pattern).toBe("**/*.ts");
    expect(typeof result.metadata.matchCount).toBe("number");
    expect(typeof result.metadata.byteCount).toBe("number");
    expect(result.title).toBe("Glob: **/*.ts");
  });

  it("matches only markdown files with specific pattern", async () => {
    const result = await tool.execute({ pattern: "**/*.md" });

    expect(result.metadata.matchCount).toBe(1);
    expect(result.output).toContain("README.md");
  });

  it("exposes the definition from builtins", () => {
    expect(tool.definition.name).toBe("glob");
    expect(tool.definition.input_schema.type).toBe("object");
    expect(tool.definition.input_schema.required).toContain("pattern");
  });
});
