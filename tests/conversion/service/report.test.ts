import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ConversionCategory } from "../../../src/agents/types";
import {
  ReportGenerator,
  ReportError,
} from "../../../src/conversion/report";
import type {
  CategoryResult,
  ConversionResult,
} from "../../../src/conversion/types";

function makeCategoryResult(
  category: ConversionCategory,
  overrides?: Partial<CategoryResult>,
): CategoryResult {
  return {
    category,
    converted: 0,
    skipped: 0,
    errors: [],
    ...overrides,
  };
}

function makeConversionResult(
  overrides?: Partial<ConversionResult>,
): ConversionResult {
  return {
    success: true,
    categories: [
      makeCategoryResult("agents", { converted: 6 }),
      makeCategoryResult("workspace-memory", { converted: 23 }),
      makeCategoryResult("auth-profiles", { converted: 2 }),
      makeCategoryResult("channel-credentials", { converted: 1 }),
      makeCategoryResult("skills", { converted: 4 }),
      makeCategoryResult("conversations", { converted: 12 }),
      makeCategoryResult("shared-references", { converted: 3 }),
      makeCategoryResult("tool-config", { converted: 1 }),
      makeCategoryResult("gateway-config", { skipped: 1, skippedReason: "not selected" }),
    ],
    totalConverted: 52,
    totalSkipped: 1,
    totalErrors: 0,
    elapsedMs: 12345,
    ...overrides,
  };
}

describe("ReportGenerator", () => {
  let tempDir: string;
  let generator: ReportGenerator;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "reins-report-test-"));
    generator = new ReportGenerator({
      outputDir: tempDir,
      importLogPath: join(tempDir, "IMPORT_LOG.md"),
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("render", () => {
    it("produces a Markdown report with header and summary table", () => {
      const result = makeConversionResult();
      const report = generator.render(result);

      expect(report).toContain("# Reins Conversion Report");
      expect(report).toContain("**Generated:**");
      expect(report).toContain("**Duration:** 12.3s");
      expect(report).toContain("**Status:** ✓ Success");
    });

    it("includes a summary table with per-category stats", () => {
      const result = makeConversionResult();
      const report = generator.render(result);

      expect(report).toContain("| Category | Converted | Skipped | Errors |");
      expect(report).toContain("| Agents | 6 | 0 | 0 |");
      expect(report).toContain("| Workspace Memory | 23 | 0 | 0 |");
      expect(report).toContain("| Auth Profiles | 2 | 0 | 0 |");
    });

    it("includes total counts in the summary", () => {
      const result = makeConversionResult();
      const report = generator.render(result);

      expect(report).toContain("**Total:** 52 converted, 1 skipped, 0 errors");
    });

    it("includes per-category details section", () => {
      const result = makeConversionResult();
      const report = generator.render(result);

      expect(report).toContain("## Details");
      expect(report).toContain("### Agents");
      expect(report).toContain("- Converted: 6");
      expect(report).toContain("### Workspace Memory");
      expect(report).toContain("- Converted: 23");
    });

    it("shows errors in category details when present", () => {
      const result = makeConversionResult({
        success: false,
        totalErrors: 2,
        categories: [
          makeCategoryResult("agents", {
            converted: 4,
            errors: [
              { item: "agent-alpha", reason: "duplicate name" },
              { item: "agent-beta", reason: "invalid workspace path" },
            ],
          }),
          makeCategoryResult("workspace-memory", { converted: 10 }),
        ],
      });

      const report = generator.render(result);

      expect(report).toContain("**Status:** ✗ Completed with errors");
      expect(report).toContain("- Errors:");
      expect(report).toContain("  - `agent-alpha`: duplicate name");
      expect(report).toContain("  - `agent-beta`: invalid workspace path");
    });

    it("references IMPORT_LOG.md in unmapped data section", () => {
      const result = makeConversionResult();
      const report = generator.render(result);

      expect(report).toContain("## Unmapped Data");
      expect(report).toContain("IMPORT_LOG.md");
    });

    it("lists categories not selected in notes section", () => {
      const result = makeConversionResult({
        categories: [
          makeCategoryResult("agents", { converted: 6 }),
          makeCategoryResult("workspace-memory", { skippedReason: "not selected" }),
          makeCategoryResult("gateway-config", { skippedReason: "not selected" }),
        ],
      });

      const report = generator.render(result);

      expect(report).toContain("## Notes");
      expect(report).toContain("Categories not selected: Workspace Memory, Gateway Config");
    });

    it("omits notes section when all categories are selected", () => {
      const result = makeConversionResult({
        categories: [
          makeCategoryResult("agents", { converted: 6 }),
          makeCategoryResult("workspace-memory", { converted: 23 }),
        ],
      });

      const report = generator.render(result);

      expect(report).not.toContain("## Notes");
      expect(report).not.toContain("Categories not selected");
    });

    it("excludes not-selected categories from the summary table", () => {
      const result = makeConversionResult({
        categories: [
          makeCategoryResult("agents", { converted: 6 }),
          makeCategoryResult("gateway-config", { skippedReason: "not selected" }),
        ],
      });

      const report = generator.render(result);

      // Agents should be in the table
      expect(report).toContain("| Agents | 6 | 0 | 0 |");
      // Gateway Config should NOT be in the summary table rows
      const tableLines = report
        .split("\n")
        .filter((line) => line.startsWith("| Gateway Config"));
      expect(tableLines).toHaveLength(0);
    });

    it("formats duration in milliseconds when under 1 second", () => {
      const result = makeConversionResult({ elapsedMs: 450 });
      const report = generator.render(result);

      expect(report).toContain("**Duration:** 450ms");
    });

    it("formats duration in seconds when 1 second or more", () => {
      const result = makeConversionResult({ elapsedMs: 5200 });
      const report = generator.render(result);

      expect(report).toContain("**Duration:** 5.2s");
    });

    it("shows skipped count in details when items are skipped", () => {
      const result = makeConversionResult({
        categories: [
          makeCategoryResult("agents", { converted: 4, skipped: 2 }),
        ],
      });

      const report = generator.render(result);

      expect(report).toContain("- Skipped: 2");
    });

    it("handles empty categories list", () => {
      const result = makeConversionResult({
        categories: [],
        totalConverted: 0,
        totalSkipped: 0,
        totalErrors: 0,
      });

      const report = generator.render(result);

      expect(report).toContain("# Reins Conversion Report");
      expect(report).toContain("**Total:** 0 converted, 0 skipped, 0 errors");
    });
  });

  describe("generate", () => {
    it("writes report to outputDir and returns the file path", async () => {
      const result = makeConversionResult();
      const generateResult = await generator.generate(result);

      expect(generateResult.ok).toBe(true);
      if (!generateResult.ok) return;

      const reportPath = generateResult.value;
      expect(reportPath).toStartWith(tempDir);
      expect(reportPath).toContain("conversion-report-");
      expect(reportPath).toEndWith(".md");

      const file = Bun.file(reportPath);
      const exists = await file.exists();
      expect(exists).toBe(true);

      const content = await file.text();
      expect(content).toContain("# Reins Conversion Report");
    });

    it("uses ISO timestamp with colons replaced by dashes in filename", async () => {
      const result = makeConversionResult();
      const generateResult = await generator.generate(result);

      expect(generateResult.ok).toBe(true);
      if (!generateResult.ok) return;

      const reportPath = generateResult.value;
      // Filename should not contain colons
      const filename = reportPath.split("/").pop()!;
      expect(filename).not.toContain(":");
      // Should match pattern: conversion-report-YYYY-MM-DDTHH-MM-SS.md
      expect(filename).toMatch(/^conversion-report-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.md$/);
    });

    it("creates parent directories if they do not exist", async () => {
      const nestedDir = join(tempDir, "nested", "deep");
      const nestedGenerator = new ReportGenerator({ outputDir: nestedDir });

      const result = makeConversionResult();
      const generateResult = await nestedGenerator.generate(result);

      expect(generateResult.ok).toBe(true);
      if (!generateResult.ok) return;

      const file = Bun.file(generateResult.value);
      expect(await file.exists()).toBe(true);
    });

    it("updates lastReportPath after successful generation", async () => {
      expect(generator.getLastReportPath()).toBeNull();

      const result = makeConversionResult();
      const generateResult = await generator.generate(result);

      expect(generateResult.ok).toBe(true);
      if (!generateResult.ok) return;

      expect(generator.getLastReportPath()).toBe(generateResult.value);
    });

    it("returns error Result on write failure", async () => {
      // Use an invalid path that cannot be created
      const badGenerator = new ReportGenerator({
        outputDir: "/dev/null/impossible/path",
      });

      const result = makeConversionResult();
      const generateResult = await badGenerator.generate(result);

      expect(generateResult.ok).toBe(false);
      if (generateResult.ok) return;

      expect(generateResult.error).toBeInstanceOf(ReportError);
      expect(generateResult.error.code).toBe("REPORT_ERROR");
    });
  });

  describe("getLastReportPath", () => {
    it("returns null when no report has been generated", () => {
      expect(generator.getLastReportPath()).toBeNull();
    });

    it("returns the path of the most recently generated report", async () => {
      const result = makeConversionResult();

      await generator.generate(result);
      const firstPath = generator.getLastReportPath();

      // Small delay to ensure different timestamp
      await new Promise((resolve) => setTimeout(resolve, 1100));

      await generator.generate(result);
      const secondPath = generator.getLastReportPath();

      expect(firstPath).not.toBeNull();
      expect(secondPath).not.toBeNull();
      expect(secondPath).not.toBe(firstPath);
    });
  });

  describe("readLastReport", () => {
    it("returns error when no report has been generated", async () => {
      const readResult = await generator.readLastReport();

      expect(readResult.ok).toBe(false);
      if (readResult.ok) return;

      expect(readResult.error).toBeInstanceOf(ReportError);
      expect(readResult.error.message).toContain("No conversion report");
    });

    it("returns the content of the last generated report", async () => {
      const result = makeConversionResult();
      await generator.generate(result);

      const readResult = await generator.readLastReport();

      expect(readResult.ok).toBe(true);
      if (!readResult.ok) return;

      expect(readResult.value).toContain("# Reins Conversion Report");
      expect(readResult.value).toContain("✓ Success");
    });

    it("returns error when report file has been deleted", async () => {
      const result = makeConversionResult();
      await generator.generate(result);

      // Delete the report file
      const reportPath = generator.getLastReportPath()!;
      await rm(reportPath);

      const readResult = await generator.readLastReport();

      expect(readResult.ok).toBe(false);
      if (readResult.ok) return;

      expect(readResult.error).toBeInstanceOf(ReportError);
      expect(readResult.error.message).toContain("not found");
    });
  });

  describe("ReportError", () => {
    it("extends ReinsError with REPORT_ERROR code", () => {
      const error = new ReportError("test error");

      expect(error).toBeInstanceOf(ReportError);
      expect(error.code).toBe("REPORT_ERROR");
      expect(error.name).toBe("ReportError");
      expect(error.message).toBe("test error");
    });

    it("preserves cause when provided", () => {
      const cause = new Error("underlying issue");
      const error = new ReportError("wrapper", cause);

      expect(error.cause).toBe(cause);
    });
  });
});
