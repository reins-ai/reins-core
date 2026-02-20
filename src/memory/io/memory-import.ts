import { access } from "node:fs/promises";
import type { MemoryRepository } from "../storage/memory-repository";
import type { CreateMemoryInput } from "../storage/memory-repository";
import { MemoryError } from "../services/memory-error";
import { err, ok, type Result } from "../../result";
import {
  validateExportedMemoryRecord,
  type ValidatedExportedMemoryRecord,
} from "./memory-schemas";
import type { MemoryFileIngestor } from "./memory-file-ingestor";

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

function toCreateInput(record: ValidatedExportedMemoryRecord): CreateMemoryInput {
  return {
    content: record.content,
    type: record.type,
    layer: record.layer,
    importance: record.importance,
    confidence: record.confidence,
    tags: record.tags,
    entities: record.entities,
    source: {
      type: record.provenance.sourceType,
      conversationId: record.provenance.conversationId,
    },
    supersedes: record.supersedes,
  };
}

export async function importMemoriesFromJson(
  repository: MemoryRepository,
  inputPath: string,
): Promise<Result<ImportResult, MemoryError>> {
  let rawText: string;
  try {
    const file = Bun.file(inputPath);
    const exists = await file.exists();
    if (!exists) {
      return err(
        new MemoryError(
          `Import file not found: ${inputPath}`,
          "MEMORY_IMPORT_FAILED",
        ),
      );
    }
    rawText = await file.text();
  } catch (cause) {
    return err(
      new MemoryError(
        `Failed to read import file: ${inputPath}`,
        "MEMORY_IMPORT_FAILED",
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (cause) {
    return err(
      new MemoryError(
        `Invalid JSON in import file: ${inputPath}`,
        "MEMORY_IMPORT_FAILED",
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  // Validate top-level structure (version, exportedAt, memories array)
  if (typeof parsed !== "object" || parsed === null) {
    return err(
      new MemoryError(
        "Import file must contain a JSON object",
        "MEMORY_IMPORT_FAILED",
      ),
    );
  }

  const fileObj = parsed as Record<string, unknown>;

  if (typeof fileObj.version !== "string") {
    return err(
      new MemoryError(
        "Import file missing required 'version' field",
        "MEMORY_IMPORT_FAILED",
      ),
    );
  }

  if (fileObj.version !== "1.0") {
    return err(
      new MemoryError(
        `Unsupported import file version: ${fileObj.version} (expected "1.0")`,
        "MEMORY_IMPORT_FAILED",
      ),
    );
  }

  if (!Array.isArray(fileObj.memories)) {
    return err(
      new MemoryError(
        "Import file missing required 'memories' array",
        "MEMORY_IMPORT_FAILED",
      ),
    );
  }

  // Load existing memories for duplicate detection
  let existingContents: Set<string>;
  try {
    const listResult = await repository.list();
    if (!listResult.ok) {
      return err(
        new MemoryError(
          `Failed to read existing memories for duplicate detection: ${listResult.error.message}`,
          "MEMORY_IMPORT_FAILED",
          listResult.error,
        ),
      );
    }
    existingContents = new Set(listResult.value.map((r) => r.content));
  } catch (cause) {
    return err(
      new MemoryError(
        "Unexpected error reading existing memories",
        "MEMORY_IMPORT_FAILED",
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  const result: ImportResult = {
    imported: 0,
    skipped: 0,
    errors: [],
  };

  const memories = fileObj.memories as unknown[];

  for (let i = 0; i < memories.length; i++) {
    const recordValidation = validateExportedMemoryRecord(memories[i], i);

    if (!recordValidation.ok) {
      const errorMessages = recordValidation.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ");
      result.errors.push(`Record ${i}: ${errorMessages}`);
      continue;
    }

    const validated = recordValidation.value;

    // Duplicate detection: skip if content already exists
    if (existingContents.has(validated.content)) {
      result.skipped++;
      continue;
    }

    try {
      const createInput = toCreateInput(validated);
      const createResult = await repository.create(createInput);

      if (!createResult.ok) {
        result.errors.push(`Record ${i} (id: ${validated.id}): ${createResult.error.message}`);
        continue;
      }

      // Track newly imported content for intra-batch duplicate detection
      existingContents.add(validated.content);
      result.imported++;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      result.errors.push(`Record ${i} (id: ${validated.id}): ${message}`);
    }
  }

  return ok(result);
}

export async function importMemoriesFromDirectory(
  ingestor: MemoryFileIngestor,
  dirPath: string,
): Promise<Result<ImportResult, MemoryError>> {
  try {
    await access(dirPath);
  } catch {
    return err(
      new MemoryError(
        `Import directory not found: ${dirPath}`,
        "MEMORY_IMPORT_FAILED",
      ),
    );
  }

  let scanResult: Awaited<ReturnType<MemoryFileIngestor["scanDirectory"]>>;
  try {
    scanResult = await ingestor.scanDirectory(dirPath);
  } catch (cause) {
    return err(
      new MemoryError(
        `Failed to scan directory: ${dirPath}`,
        "MEMORY_IMPORT_FAILED",
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  if (!scanResult.ok) {
    return err(
      new MemoryError(
        `Failed to scan directory: ${scanResult.error.message}`,
        "MEMORY_IMPORT_FAILED",
        scanResult.error instanceof Error ? scanResult.error : undefined,
      ),
    );
  }

  const report = scanResult.value;
  const result: ImportResult = {
    imported: report.ingested + report.updated,
    skipped: report.skipped + report.quarantined,
    errors: report.errors.map((e) => `${e.file}: ${e.error}`),
  };

  return ok(result);
}
