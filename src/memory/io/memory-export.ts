import type { MemoryRecord } from "../types/memory-record";
import type { MemoryRepository } from "../storage/memory-repository";
import { MemoryError } from "../services/memory-error";
import { err, ok, type Result } from "../../result";

export interface ExportResult {
  path: string;
  count: number;
  exportedAt: string;
}

export interface ExportedMemoryRecord {
  id: string;
  content: string;
  type: string;
  layer: string;
  importance: number;
  confidence: number;
  tags: string[];
  entities: string[];
  provenance: {
    sourceType: string;
    conversationId?: string;
  };
  supersedes?: string;
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
  accessedAt: string;
}

export interface MemoryExportFile {
  version: string;
  exportedAt: string;
  memories: ExportedMemoryRecord[];
}

function toExportedRecord(record: MemoryRecord): ExportedMemoryRecord {
  const exported: ExportedMemoryRecord = {
    id: record.id,
    content: record.content,
    type: record.type,
    layer: record.layer,
    importance: record.importance,
    confidence: record.confidence,
    tags: record.tags,
    entities: record.entities,
    provenance: {
      sourceType: record.provenance.sourceType,
      ...(record.provenance.conversationId
        ? { conversationId: record.provenance.conversationId }
        : {}),
    },
    ...(record.supersedes ? { supersedes: record.supersedes } : {}),
    ...(record.supersededBy ? { supersededBy: record.supersededBy } : {}),
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    accessedAt: record.accessedAt.toISOString(),
  };

  return exported;
}

export async function exportMemories(
  repository: MemoryRepository,
  outputPath: string,
): Promise<Result<ExportResult, MemoryError>> {
  const exportedAt = new Date().toISOString();

  let records: MemoryRecord[];
  try {
    const listResult = await repository.list();
    if (!listResult.ok) {
      return err(
        new MemoryError(
          `Failed to read memories for export: ${listResult.error.message}`,
          "MEMORY_EXPORT_FAILED",
          listResult.error,
        ),
      );
    }
    records = listResult.value;
  } catch (cause) {
    return err(
      new MemoryError(
        "Unexpected error reading memories for export",
        "MEMORY_EXPORT_FAILED",
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  const exportFile: MemoryExportFile = {
    version: "1.0",
    exportedAt,
    memories: records.map(toExportedRecord),
  };

  try {
    await Bun.write(outputPath, JSON.stringify(exportFile, null, 2));
  } catch (cause) {
    return err(
      new MemoryError(
        `Failed to write export file to ${outputPath}`,
        "MEMORY_EXPORT_FAILED",
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  return ok({
    path: outputPath,
    count: records.length,
    exportedAt,
  });
}
