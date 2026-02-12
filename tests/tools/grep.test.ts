import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { GrepTool } from "../../src/tools/system/grep";
import { SystemToolExecutionError } from "../../src/tools/system/types";

describe("GrepTool", () => {
  let sandboxRoot: string;
  let tool: GrepTool;

  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "reins-grep-"));
    tool = new GrepTool(sandboxRoot);

    mkdirSync(join(sandboxRoot, "src"), { recursive: true });
    mkdirSync(join(sandboxRoot, "tests"), { recursive: true });

    writeFileSync(
      join(sandboxRoot, "src", "index.ts"),
      [
        'import { hello } from "./hello";',
        "",
        "export function main() {",
        '  console.log("starting");',
        "  hello();",
        "}",
      ].join("\n"),
    );

    writeFileSync(
      join(sandboxRoot, "src", "hello.ts"),
      [
        "export function hello() {",
        '  return "Hello, world!";',
        "}",
        "",
        "export function goodbye() {",
        '  return "Goodbye!";',
        "}",
      ].join("\n"),
    );

    writeFileSync(
      join(sandboxRoot, "tests", "hello.test.ts"),
      [
        'import { hello } from "../src/hello";',
        "",
        'describe("hello", () => {',
        '  it("returns greeting", () => {',
        "    expect(hello()).toBe(\"Hello, world!\");",
        "  });",
        "});",
      ].join("\n"),
    );

    writeFileSync(join(sandboxRoot, "README.md"), "# Project\n\nHello documentation.");
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("finds matching lines with regex", async () => {
    const result = await tool.execute({ pattern: "function" });

    expect(result.metadata.matchCount).toBeGreaterThanOrEqual(3);
    expect(result.output).toContain("function main()");
    expect(result.output).toContain("function hello()");
    expect(result.output).toContain("function goodbye()");
  });

  it("returns file path + line number + content per match", async () => {
    const result = await tool.execute({ pattern: "function hello" });

    const lines = result.output.split("\n");
    for (const line of lines) {
      expect(line).toMatch(/^.+:\d+: .+$/);
    }

    expect(result.output).toContain("src/hello.ts:1:");
  });

  it("respects maxResults cap", async () => {
    const result = await tool.execute({ pattern: ".", maxResults: 3 });

    expect(result.metadata.matchCount).toBe(3);
    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.cappedAt).toBe(3);
  });

  it("sets truncation metadata when capped", async () => {
    const result = await tool.execute({ pattern: ".", maxResults: 2 });

    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.cappedAt).toBe(2);
    expect(result.metadata.matchCount).toBe(2);
  });

  it("does not set cappedAt when not truncated", async () => {
    const result = await tool.execute({ pattern: "function hello" });

    expect(result.metadata.truncated).toBe(false);
    expect(result.metadata.cappedAt).toBeUndefined();
  });

  it("returns sorted output by file path then line number", async () => {
    const result = await tool.execute({ pattern: "hello" });

    const lines = result.output.split("\n");
    const paths = lines.map((line) => {
      const colonIndex = line.indexOf(":");
      return line.slice(0, colonIndex);
    });

    const sortedPaths = [...paths].sort();
    expect(paths).toEqual(sortedPaths);
  });

  it("rejects invalid regex pattern", async () => {
    await expect(
      tool.execute({ pattern: "[invalid" }),
    ).rejects.toBeInstanceOf(SystemToolExecutionError);

    try {
      await tool.execute({ pattern: "[invalid" });
    } catch (error) {
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_VALIDATION_FAILED");
      expect(toolError.details?.["reason"]).toBe("invalid_regex");
    }
  });

  it("rejects path outside sandbox", async () => {
    await expect(
      tool.execute({ pattern: "test", path: "/etc" }),
    ).rejects.toBeInstanceOf(SystemToolExecutionError);

    try {
      await tool.execute({ pattern: "test", path: "/etc" });
    } catch (error) {
      const toolError = error as SystemToolExecutionError;
      expect(toolError.code).toBe("TOOL_PERMISSION_DENIED");
    }
  });

  it("handles file filter with include parameter", async () => {
    const result = await tool.execute({ pattern: "hello", include: "*.ts" });

    expect(result.output).toContain(".ts:");
    expect(result.output).not.toContain("README.md");
  });

  it("returns no matches message when nothing found", async () => {
    const result = await tool.execute({ pattern: "zzz_nonexistent_zzz" });

    expect(result.output).toBe("No matches found.");
    expect(result.metadata.matchCount).toBe(0);
    expect(result.metadata.truncated).toBe(false);
  });

  it("searches from subdirectory when path is provided", async () => {
    const result = await tool.execute({ pattern: "function", path: "tests" });

    expect(result.output).not.toContain("src/index.ts");
    expect(result.output).not.toContain("src/hello.ts");
  });

  it("skips unreadable files without failing", async () => {
    mkdirSync(join(sandboxRoot, "binary"), { recursive: true });
    writeFileSync(join(sandboxRoot, "binary", "data.bin"), Buffer.from([0x00, 0xff, 0xfe]));
    writeFileSync(join(sandboxRoot, "src", "extra.ts"), "function findMe() {}");

    const result = await tool.execute({ pattern: "findMe", include: "*.ts" });

    expect(result.output).toContain("findMe");
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

  it("includes metadata with pattern and search info", async () => {
    const result = await tool.execute({ pattern: "hello" });

    expect(result.metadata.pattern).toBe("hello");
    expect(typeof result.metadata.matchCount).toBe("number");
    expect(typeof result.metadata.byteCount).toBe("number");
    expect(result.title).toBe("Grep: hello");
  });

  it("supports regex special characters", async () => {
    const result = await tool.execute({ pattern: "console\\.log" });

    expect(result.metadata.matchCount).toBeGreaterThanOrEqual(1);
    expect(result.output).toContain("console.log");
  });

  it("exposes the definition from builtins", () => {
    expect(tool.definition.name).toBe("grep");
    expect(tool.definition.input_schema.type).toBe("object");
    expect(tool.definition.input_schema.required).toContain("pattern");
  });
});
