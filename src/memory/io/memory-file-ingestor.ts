import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";

import { err, ok, type Result } from "../../result";
import { ReinsError } from "../../errors";
import { parse } from "./markdown-memory-codec";
import type { MemoryFileRecord } from "./frontmatter-schema";
import type { MemoryRepository, UpdateMemoryInput } from "../storage/memory-repository";

export class MemoryIngestError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "MEMORY_INGEST_ERROR", cause);
    this.name = "MemoryIngestError";
  }
}

export interface IngestResult {
  action: "created" | "updated" | "skipped" | "quarantined";
  memoryId?: string;
  reason?: string;
}

export interface ScanReport {
  totalFiles: number;
  ingested: number;
  updated: number;
  skipped: number;
  quarantined: number;
  errors: Array<{ file: string; error: string }>;
}

export interface MemoryFileIngestorOptions {
  repository: MemoryRepository;
  codec: { parse: typeof parse };
  quarantineDir: string;
  logger?: {
    warn(message: string): void;
    info(message: string): void;
    error(message: string): void;
  };
}

function asError(value: unknown): Error | undefined {
  return value instanceof Error ? value : undefined;
}

function fileRecordToUpdateInput(record: MemoryFileRecord): UpdateMemoryInput {
  return {
    content: record.content,
    importance: record.importance,
    confidence: record.confidence,
    tags: record.tags,
    entities: record.entities,
    supersedes: record.supersedes ?? undefined,
    supersededBy: record.supersededBy ?? undefined,
  };
}

function hasContentChanged(
  existing: { content: string; importance: number; confidence: number; tags: string[]; entities: string[] },
  parsed: MemoryFileRecord,
): boolean {
  if (existing.content !== parsed.content) return true;
  if (existing.importance !== parsed.importance) return true;
  if (existing.confidence !== parsed.confidence) return true;

  const existingTags = [...existing.tags].sort();
  const parsedTags = [...parsed.tags].sort();
  if (existingTags.length !== parsedTags.length) return true;
  for (let i = 0; i < existingTags.length; i++) {
    if (existingTags[i] !== parsedTags[i]) return true;
  }

  const existingEntities = [...existing.entities].sort();
  const parsedEntities = [...parsed.entities].sort();
  if (existingEntities.length !== parsedEntities.length) return true;
  for (let i = 0; i < existingEntities.length; i++) {
    if (existingEntities[i] !== parsedEntities[i]) return true;
  }

  return false;
}

export class MemoryFileIngestor {
  private readonly repository: MemoryRepository;
  private readonly codec: { parse: typeof parse };
  private readonly quarantineDir: string;
  private readonly logger?: MemoryFileIngestorOptions["logger"];

  constructor(options: MemoryFileIngestorOptions) {
    this.repository = options.repository;
    this.codec = options.codec;
    this.quarantineDir = options.quarantineDir;
    this.logger = options.logger;
  }

  async ingestFile(filePath: string): Promise<Result<IngestResult>> {
    let markdown: string;
    try {
      markdown = await readFile(filePath, "utf8");
    } catch (cause) {
      return err(
        new MemoryIngestError(
          `Failed to read file: ${filePath}`,
          asError(cause),
        ),
      );
    }

    const parsed = this.codec.parse(markdown);
    if (!parsed.ok) {
      const quarantineResult = await this.quarantineFile(filePath, parsed.error.message);
      if (!quarantineResult.ok) {
        return quarantineResult;
      }

      return ok({
        action: "quarantined",
        reason: parsed.error.message,
      });
    }

    const record = parsed.value;

    const existing = await this.repository.getById(record.id);
    if (!existing.ok) {
      return err(
        new MemoryIngestError(
          `Failed to look up memory '${record.id}' in repository`,
          existing.error,
        ),
      );
    }

    if (existing.value) {
      const changed = hasContentChanged(existing.value, record);
      if (!changed) {
        return ok({
          action: "skipped",
          memoryId: record.id,
          reason: "No changes detected",
        });
      }

      const updateInput = fileRecordToUpdateInput(record);
      const updateResult = await this.repository.update(record.id, updateInput);
      if (!updateResult.ok) {
        return err(
          new MemoryIngestError(
            `Failed to update memory '${record.id}'`,
            updateResult.error,
          ),
        );
      }

      this.logger?.info(`Updated memory '${record.id}' from file edit`);
      return ok({
        action: "updated",
        memoryId: record.id,
      });
    }

    // Memory doesn't exist in DB — create it
    const createResult = await this.repository.create({
      content: record.content,
      type: record.type as Parameters<MemoryRepository["create"]>[0]["type"],
      layer: record.layer as Parameters<MemoryRepository["create"]>[0]["layer"],
      importance: record.importance,
      confidence: record.confidence,
      tags: record.tags,
      entities: record.entities,
      source: {
        type: record.source.type as Parameters<MemoryRepository["create"]>[0]["source"]["type"],
        conversationId: record.source.conversationId,
        messageId: record.source.messageId,
      },
      supersedes: record.supersedes ?? undefined,
    });

    if (!createResult.ok) {
      return err(
        new MemoryIngestError(
          `Failed to create memory from file: ${filePath}`,
          createResult.error,
        ),
      );
    }

    this.logger?.info(`Ingested new memory '${createResult.value.id}' from file`);
    return ok({
      action: "created",
      memoryId: createResult.value.id,
    });
  }

  async handleDeletion(filePath: string): Promise<Result<void>> {
    // For deletions, we report but don't auto-delete DB records.
    // The spec says: "Do not auto-delete DB records when files are missing (just report)"
    this.logger?.warn(`File deleted: ${filePath} — DB record preserved (manual cleanup required)`);
    return ok(undefined);
  }

  async scanDirectory(dirPath: string): Promise<Result<ScanReport>> {
    const report: ScanReport = {
      totalFiles: 0,
      ingested: 0,
      updated: 0,
      skipped: 0,
      quarantined: 0,
      errors: [],
    };

    let entries: string[];
    try {
      entries = await readdir(dirPath);
    } catch (cause) {
      const error = asError(cause);
      if (error && "code" in error && error.code === "ENOENT") {
        return ok(report);
      }

      return err(
        new MemoryIngestError(
          `Failed to read directory: ${dirPath}`,
          error,
        ),
      );
    }

    const mdFiles = entries.filter((entry) => entry.endsWith(".md"));
    report.totalFiles = mdFiles.length;

    for (const fileName of mdFiles) {
      const filePath = join(dirPath, fileName);

      let fileStat;
      try {
        fileStat = await stat(filePath);
      } catch {
        report.errors.push({ file: fileName, error: "Failed to stat file" });
        continue;
      }

      if (!fileStat.isFile()) {
        continue;
      }

      const result = await this.ingestFile(filePath);
      if (!result.ok) {
        report.errors.push({ file: fileName, error: result.error.message });
        continue;
      }

      switch (result.value.action) {
        case "created":
          report.ingested++;
          break;
        case "updated":
          report.updated++;
          break;
        case "skipped":
          report.skipped++;
          break;
        case "quarantined":
          report.quarantined++;
          break;
      }
    }

    return ok(report);
  }

  private async quarantineFile(filePath: string, errorMessage: string): Promise<Result<void>> {
    try {
      await mkdir(this.quarantineDir, { recursive: true });

      const fileName = basename(filePath);
      const quarantinePath = join(this.quarantineDir, fileName);
      const errorPath = join(this.quarantineDir, `${fileName}.error`);

      await rename(filePath, quarantinePath);
      await writeFile(errorPath, `Parse error: ${errorMessage}\nOriginal path: ${filePath}\nQuarantined at: ${new Date().toISOString()}\n`, "utf8");

      this.logger?.warn(`Quarantined invalid file: ${fileName} — ${errorMessage}`);
      return ok(undefined);
    } catch (cause) {
      return err(
        new MemoryIngestError(
          `Failed to quarantine file: ${filePath}`,
          asError(cause),
        ),
      );
    }
  }
}
