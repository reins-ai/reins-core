import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ReinsError } from "../errors";
import { err, ok, type Result } from "../result";
import type { CategoryResult, ConversionResult } from "./types";

export class ReportError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "REPORT_ERROR", cause);
    this.name = "ReportError";
  }
}

export interface ReportGeneratorOptions {
  /** Directory where reports are written. Defaults to `~/.reins`. */
  outputDir?: string;
  /** Path to the import log file referenced in reports. Defaults to `~/.reins/IMPORT_LOG.md`. */
  importLogPath?: string;
}

/**
 * Generates human-readable Markdown conversion reports from ConversionResult.
 * Reports include per-category stats, errors, and a reference to IMPORT_LOG.md.
 */
export class ReportGenerator {
  private readonly outputDir: string;
  private readonly importLogPath: string;
  private lastReportPath: string | null = null;

  constructor(options?: ReportGeneratorOptions) {
    const reinsDir = join(homedir(), ".reins");
    this.outputDir = options?.outputDir ?? reinsDir;
    this.importLogPath = options?.importLogPath ?? join(reinsDir, "IMPORT_LOG.md");
  }

  /**
   * Generate a report, write it to disk, and return the file path.
   */
  async generate(result: ConversionResult): Promise<Result<string>> {
    try {
      const content = this.render(result);
      const timestamp = new Date()
        .toISOString()
        .replace(/:/g, "-")
        .replace(/\..+/, "");
      const filename = `conversion-report-${timestamp}.md`;
      const reportPath = join(this.outputDir, filename);

      await mkdir(dirname(reportPath), { recursive: true });
      await Bun.write(reportPath, content);

      this.lastReportPath = reportPath;
      return ok(reportPath);
    } catch (cause) {
      return err(
        new ReportError(
          "Failed to generate conversion report",
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Return the path of the last generated report, or null if none.
   */
  getLastReportPath(): string | null {
    return this.lastReportPath;
  }

  /**
   * Read the content of the last generated report.
   */
  async readLastReport(): Promise<Result<string>> {
    if (!this.lastReportPath) {
      return err(new ReportError("No conversion report has been generated"));
    }

    try {
      const file = Bun.file(this.lastReportPath);
      const exists = await file.exists();
      if (!exists) {
        return err(
          new ReportError(`Report file not found: ${this.lastReportPath}`),
        );
      }
      const content = await file.text();
      return ok(content);
    } catch (cause) {
      return err(
        new ReportError(
          `Failed to read report: ${this.lastReportPath}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Pure render — produces the Markdown report string without any file I/O.
   */
  render(result: ConversionResult): string {
    const lines: string[] = [];

    lines.push("# Reins Conversion Report");
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push(`**Duration:** ${formatDuration(result.elapsedMs)}`);
    lines.push(`**Status:** ${result.success ? "✓ Success" : "✗ Completed with errors"}`);
    lines.push("");

    // Summary table
    lines.push("## Summary");
    lines.push("");
    lines.push("| Category | Converted | Skipped | Errors |");
    lines.push("|----------|-----------|---------|--------|");

    const selectedCategories: CategoryResult[] = [];
    const notSelectedCategories: CategoryResult[] = [];

    for (const cat of result.categories) {
      if (cat.skippedReason === "not selected") {
        notSelectedCategories.push(cat);
      } else {
        selectedCategories.push(cat);
      }
    }

    for (const cat of selectedCategories) {
      lines.push(
        `| ${formatCategoryName(cat.category)} | ${cat.converted} | ${cat.skipped} | ${cat.errors.length} |`,
      );
    }

    lines.push("");
    lines.push(
      `**Total:** ${result.totalConverted} converted, ${result.totalSkipped} skipped, ${result.totalErrors} errors`,
    );
    lines.push("");

    // Details section
    lines.push("## Details");
    lines.push("");

    for (const cat of selectedCategories) {
      lines.push(`### ${formatCategoryName(cat.category)}`);
      lines.push(`- Converted: ${cat.converted}`);
      lines.push(`- Skipped: ${cat.skipped}`);

      if (cat.errors.length > 0) {
        lines.push("- Errors:");
        for (const error of cat.errors) {
          lines.push(`  - \`${error.item}\`: ${error.reason}`);
        }
      }

      lines.push("");
    }

    // Unmapped data reference
    lines.push("## Unmapped Data");
    lines.push("");
    lines.push(`See: \`${this.importLogPath}\` for full list of unmapped fields.`);
    lines.push("");

    // Notes section
    if (notSelectedCategories.length > 0) {
      lines.push("## Notes");
      lines.push("");
      const names = notSelectedCategories
        .map((c) => formatCategoryName(c.category))
        .join(", ");
      lines.push(`- Categories not selected: ${names}`);
      lines.push("");
    }

    return lines.join("\n");
  }
}

/**
 * Format elapsed milliseconds into a human-readable duration string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  return `${seconds.toFixed(1)}s`;
}

/**
 * Convert a kebab-case category slug into a human-readable title.
 */
function formatCategoryName(category: string): string {
  return category
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
