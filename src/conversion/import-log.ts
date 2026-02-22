import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { ReinsError } from "../errors";
import { err, ok, type Result } from "../result";

/**
 * A single entry representing an unmapped field or file from the conversion.
 */
export interface ImportLogEntry {
  /** Dot-separated path to the original field (e.g. "gateway.tailscale.enabled"). */
  path: string;
  /** The original value from the source config. */
  originalValue: unknown;
  /** Whether the value is a secret that should be redacted in the log. */
  isSecret: boolean;
  /** Human-readable reason why this field was not mapped. */
  reason: string;
  /** Grouping category for the entry (e.g. "gateway", "browser", "agents"). */
  category: string;
}

export class ImportLogError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "IMPORT_LOG_ERROR", cause);
    this.name = "ImportLogError";
  }
}

export interface ImportLogWriterOptions {
  /** Override the output file path. Defaults to `~/.reins/IMPORT_LOG.md`. */
  outputPath?: string;
}

/**
 * Accumulates unmapped conversion entries and writes them as a structured
 * Markdown log file. Secret values are redacted with `[REDACTED]`.
 */
export class ImportLogWriter {
  private readonly outputPath: string;
  private entries: ImportLogEntry[] = [];

  constructor(options?: ImportLogWriterOptions) {
    this.outputPath =
      options?.outputPath ?? join(homedir(), ".reins", "IMPORT_LOG.md");
  }

  /**
   * Add an unmapped entry to the log.
   */
  addEntry(entry: ImportLogEntry): void {
    this.entries.push(entry);
  }

  /**
   * Return the current number of accumulated entries.
   */
  get entryCount(): number {
    return this.entries.length;
  }

  /**
   * Reset all accumulated entries.
   */
  clear(): void {
    this.entries = [];
  }

  /**
   * Write the accumulated entries to the output file as structured Markdown.
   * Creates parent directories if they do not exist.
   */
  async write(): Promise<Result<void, ImportLogError>> {
    try {
      const content = this.render();
      await mkdir(dirname(this.outputPath), { recursive: true });
      await Bun.write(this.outputPath, content);
      return ok(undefined);
    } catch (cause) {
      return err(
        new ImportLogError(
          `Failed to write import log to ${this.outputPath}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Render the Markdown content without writing to disk.
   * Useful for testing and previewing.
   */
  render(): string {
    const lines: string[] = [];

    lines.push("# Reins Import Log");
    lines.push(`**Generated:** ${new Date().toISOString()}`);
    lines.push("");

    if (this.entries.length === 0) {
      lines.push("No unmapped data found during conversion.");
      lines.push("");
      return lines.join("\n");
    }

    lines.push(
      `**Total unmapped entries:** ${this.entries.length}`,
    );
    lines.push("");

    const grouped = this.groupByCategory();
    const categories = Array.from(grouped.keys()).sort();

    for (const category of categories) {
      const categoryEntries = grouped.get(category)!;
      lines.push(`## ${category}`);
      lines.push("");
      lines.push("| Path | Value | Reason |");
      lines.push("| --- | --- | --- |");

      for (const entry of categoryEntries) {
        const displayValue = entry.isSecret
          ? "[REDACTED]"
          : escapeMarkdownTableCell(formatValue(entry.originalValue));
        const displayPath = escapeMarkdownTableCell(entry.path);
        const displayReason = escapeMarkdownTableCell(entry.reason);
        lines.push(`| ${displayPath} | ${displayValue} | ${displayReason} |`);
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  private groupByCategory(): Map<string, ImportLogEntry[]> {
    const grouped = new Map<string, ImportLogEntry[]>();

    for (const entry of this.entries) {
      const existing = grouped.get(entry.category);
      if (existing) {
        existing.push(entry);
      } else {
        grouped.set(entry.category, [entry]);
      }
    }

    return grouped;
  }
}

/**
 * Format an unknown value into a human-readable string for the log table.
 */
function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/**
 * Escape pipe characters in Markdown table cells to prevent layout breakage.
 */
function escapeMarkdownTableCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
