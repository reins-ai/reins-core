import { join } from "node:path";

import { err, ok, type Result } from "../../result";
import type { MemoryRecord } from "../types/memory-record";
import type { MemoryEvent } from "../types/memory-events";
import { MEMORY_TYPES, type MemoryType } from "../types/memory-types";
import type { MemoryRepository } from "../storage/memory-repository";
import { MemoryError } from "./memory-error";

export interface MemorySummaryOptions {
  repository: MemoryRepository;
  debounceMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 500;

const TYPE_DISPLAY_NAMES: Record<MemoryType, string> = {
  fact: "Facts",
  preference: "Preferences",
  decision: "Decisions",
  episode: "Episodes",
  skill: "Skills",
  entity: "Entities",
  document_chunk: "Document Chunks",
};

function importanceLabel(importance: number): string {
  if (importance >= 0.7) {
    return "high";
  }

  if (importance >= 0.4) {
    return "medium";
  }

  return "low";
}

function contentPreview(content: string, maxLength: number = 80): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }

  return singleLine.slice(0, maxLength - 3) + "...";
}

export function formatRelativeDate(date: Date, now: Date = new Date()): string {
  const diffMs = now.getTime() - date.getTime();

  if (diffMs < 0) {
    return "just now";
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return "just now";
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return minutes === 1 ? "1 minute ago" : `${minutes} minutes ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return hours === 1 ? "1 hour ago" : `${hours} hours ago`;
  }

  const days = Math.floor(hours / 24);
  if (days < 30) {
    return days === 1 ? "1 day ago" : `${days} days ago`;
  }

  const months = Math.floor(days / 30);
  if (months < 12) {
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }

  const years = Math.floor(months / 12);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

function renderRecord(record: MemoryRecord, now: Date): string {
  const lines: string[] = [];
  lines.push(`### ${contentPreview(record.content)}`);
  lines.push(`- Importance: ${importanceLabel(record.importance)}`);
  lines.push(`- Tags: ${record.tags.length > 0 ? record.tags.join(", ") : "none"}`);
  lines.push(`- Created: ${formatRelativeDate(record.createdAt, now)}`);
  lines.push(`- Last accessed: ${formatRelativeDate(record.accessedAt, now)}`);
  return lines.join("\n");
}

function generateMarkdown(records: MemoryRecord[], now: Date): string {
  const lines: string[] = [];
  lines.push("# Memory Summary");
  lines.push("");
  lines.push(`*Auto-generated. Last updated: ${now.toISOString()}*`);

  const grouped = new Map<MemoryType, MemoryRecord[]>();
  for (const record of records) {
    const existing = grouped.get(record.type);
    if (existing) {
      existing.push(record);
    } else {
      grouped.set(record.type, [record]);
    }
  }

  for (const memoryType of MEMORY_TYPES) {
    const typeRecords = grouped.get(memoryType);
    if (!typeRecords || typeRecords.length === 0) {
      continue;
    }

    lines.push("");
    lines.push(`## ${TYPE_DISPLAY_NAMES[memoryType]}`);

    for (const record of typeRecords) {
      lines.push("");
      lines.push(renderRecord(record, now));
    }
  }

  lines.push("");
  return lines.join("\n");
}

export class MemorySummaryGenerator {
  private readonly repository: MemoryRepository;
  private readonly debounceMs: number;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEnvDir: string | null = null;

  constructor(options: MemorySummaryOptions) {
    this.repository = options.repository;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  async generate(envDir: string): Promise<Result<void, MemoryError>> {
    try {
      const listResult = await this.repository.list();
      if (!listResult.ok) {
        return err(
          new MemoryError(
            `Failed to read memories for summary: ${listResult.error.message}`,
            "MEMORY_DB_ERROR",
            listResult.error,
          ),
        );
      }

      const now = new Date();
      const markdown = generateMarkdown(listResult.value, now);
      const filePath = join(envDir, "MEMORY.md");

      await Bun.write(filePath, markdown);

      return ok(undefined);
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      return err(
        new MemoryError(
          `Failed to generate MEMORY.md: ${error.message}`,
          "MEMORY_DB_ERROR",
          error,
        ),
      );
    }
  }

  subscribeToEvents(envDir: string): (event: MemoryEvent) => void {
    return (_event: MemoryEvent) => {
      this.scheduleGenerate(envDir);
    };
  }

  cancelPending(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
      this.pendingEnvDir = null;
    }
  }

  private scheduleGenerate(envDir: string): void {
    this.cancelPending();
    this.pendingEnvDir = envDir;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      const dir = this.pendingEnvDir;
      this.pendingEnvDir = null;
      if (dir) {
        void this.generate(dir);
      }
    }, this.debounceMs);
  }
}
