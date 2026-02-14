import { createHash } from "node:crypto";

import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { Message } from "../../types";
import type { ExtractionCategory, ExtractionResult, SessionExtractor } from "../../memory/capture";

const HIGH_VALUE_CATEGORIES: ReadonlySet<ExtractionCategory> = new Set([
  "decision",
  "fact",
  "preference",
]);

export interface CompactionContext {
  conversationId: string;
  sessionId: string;
  compactionReason: string;
  timestamp: Date;
  truncationPoint: number;
}

export interface PreservationResult {
  extractedCount: number;
  persistedCount: number;
  idempotencyKey: string;
  skippedDuplicates: number;
}

export interface PreCompactionHook {
  onPreCompaction(
    messages: Message[],
    compactionContext: CompactionContext,
  ): Promise<Result<PreservationResult, MemoryPreservationError>>;
}

export interface MemoryPreservationHookOptions {
  sessionExtractor: SessionExtractor;
}

export class MemoryPreservationError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "MemoryPreservationError";
  }
}

export class MemoryPreservationHook implements PreCompactionHook {
  private readonly sessionExtractor: SessionExtractor;
  private readonly processedCompactions = new Set<string>();

  constructor(options: MemoryPreservationHookOptions) {
    this.sessionExtractor = options.sessionExtractor;
  }

  async onPreCompaction(
    messages: Message[],
    compactionContext: CompactionContext,
  ): Promise<Result<PreservationResult, MemoryPreservationError>> {
    const idempotencyKey = this.createIdempotencyKey(messages, compactionContext);
    if (this.processedCompactions.has(idempotencyKey)) {
      return ok({
        extractedCount: 0,
        persistedCount: 0,
        idempotencyKey,
        skippedDuplicates: 1,
      });
    }

    if (messages.length === 0) {
      this.processedCompactions.add(idempotencyKey);
      return ok({
        extractedCount: 0,
        persistedCount: 0,
        idempotencyKey,
        skippedDuplicates: 0,
      });
    }

    const extractionResult = await this.sessionExtractor.extractFromSession(messages, {
      sessionId: compactionContext.sessionId,
      conversationId: compactionContext.conversationId,
      timestamp: compactionContext.timestamp,
    });
    if (!extractionResult.ok) {
      return err(
        new MemoryPreservationError(
          "Failed to extract memory candidates before compaction",
          "COMPACTION_PRESERVATION_EXTRACT_FAILED",
          extractionResult.error,
        ),
      );
    }

    const preservationExtraction = this.toCompactionExtraction(extractionResult.value, compactionContext);
    const persisted = await this.sessionExtractor.persistExtractions(preservationExtraction);
    if (!persisted.ok) {
      return err(
        new MemoryPreservationError(
          "Failed to persist compaction-preserved memories",
          "COMPACTION_PRESERVATION_PERSIST_FAILED",
          persisted.error,
        ),
      );
    }

    this.processedCompactions.add(idempotencyKey);
    return ok({
      extractedCount: preservationExtraction.items.length,
      persistedCount: persisted.value.length,
      idempotencyKey,
      skippedDuplicates: 0,
    });
  }

  private toCompactionExtraction(
    extractionResult: ExtractionResult,
    compactionContext: CompactionContext,
  ): ExtractionResult {
    const compactionTags = [
      "source:compaction",
      `compaction-reason:${compactionContext.compactionReason}`,
      `compaction-truncation-point:${compactionContext.truncationPoint}`,
    ];

    return {
      ...extractionResult,
      items: extractionResult.items
        .filter((item) => HIGH_VALUE_CATEGORIES.has(item.category))
        .map((item) => ({
          ...item,
          tags: unique([...item.tags, ...compactionTags]),
        })),
    };
  }

  private createIdempotencyKey(messages: Message[], compactionContext: CompactionContext): string {
    const sortedMessageIds = messages.map((message) => message.id).sort();
    const messageHash = createHash("sha256")
      .update(sortedMessageIds.join("|"), "utf8")
      .digest("hex");

    return [
      compactionContext.conversationId,
      String(compactionContext.truncationPoint),
      messageHash,
    ].join(":");
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
