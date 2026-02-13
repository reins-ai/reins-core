import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type { MemorySourceType } from "./memory-types";

/**
 * Extraction event types that describe how a memory was captured.
 */
export const EXTRACTION_EVENTS = [
  "session_end",
  "compaction",
  "manual",
  "file_ingestion",
  "consolidation",
] as const;

export type ExtractionEvent = (typeof EXTRACTION_EVENTS)[number];

/**
 * Extended provenance record that captures full extraction context
 * for traceability from memory back to its source conversation and event.
 *
 * This complements the simpler MemoryProvenance on MemoryRecord by adding
 * session-level, message-level, and extraction-event metadata.
 */
export interface ProvenanceRecord {
  source: MemorySourceType;
  conversationId?: string;
  sessionId?: string;
  messageIds?: string[];
  extractionEvent?: ExtractionEvent;
  extractedAt: string;
  confidence?: number;
  extractionVersion: string;
}

/**
 * Filter criteria for querying provenance records.
 */
export interface ProvenanceFilter {
  source?: MemorySourceType | MemorySourceType[];
  conversationId?: string;
  extractionEvent?: ExtractionEvent;
  after?: string;
  before?: string;
}

export class ProvenanceValidationError extends ReinsError {
  constructor(message: string) {
    super(message, "PROVENANCE_VALIDATION_ERROR");
    this.name = "ProvenanceValidationError";
  }
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function isValidExtractionEvent(value: string): value is ExtractionEvent {
  return EXTRACTION_EVENTS.includes(value as ExtractionEvent);
}

/**
 * Validates a ProvenanceRecord, checking required fields and value constraints.
 */
export function validateProvenance(
  record: ProvenanceRecord,
): Result<ProvenanceRecord, ProvenanceValidationError> {
  if (!record.source || typeof record.source !== "string") {
    return err(new ProvenanceValidationError("source is required and must be a string"));
  }

  if (!record.extractedAt || typeof record.extractedAt !== "string") {
    return err(new ProvenanceValidationError("extractedAt is required and must be a string"));
  }

  if (!ISO_DATE_PATTERN.test(record.extractedAt)) {
    return err(new ProvenanceValidationError("extractedAt must be a valid ISO 8601 date string"));
  }

  if (!record.extractionVersion || typeof record.extractionVersion !== "string") {
    return err(new ProvenanceValidationError("extractionVersion is required and must be a non-empty string"));
  }

  if (record.extractionVersion.trim().length === 0) {
    return err(new ProvenanceValidationError("extractionVersion must be a non-empty string"));
  }

  if (record.conversationId !== undefined) {
    if (typeof record.conversationId !== "string" || record.conversationId.trim().length === 0) {
      return err(new ProvenanceValidationError("conversationId must be a non-empty string when provided"));
    }
  }

  if (record.sessionId !== undefined) {
    if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
      return err(new ProvenanceValidationError("sessionId must be a non-empty string when provided"));
    }
  }

  if (record.messageIds !== undefined) {
    if (!Array.isArray(record.messageIds)) {
      return err(new ProvenanceValidationError("messageIds must be an array when provided"));
    }

    for (let i = 0; i < record.messageIds.length; i++) {
      if (typeof record.messageIds[i] !== "string" || record.messageIds[i].trim().length === 0) {
        return err(new ProvenanceValidationError(`messageIds[${i}] must be a non-empty string`));
      }
    }
  }

  if (record.extractionEvent !== undefined) {
    if (typeof record.extractionEvent !== "string" || !isValidExtractionEvent(record.extractionEvent)) {
      return err(
        new ProvenanceValidationError(
          `extractionEvent must be one of: ${EXTRACTION_EVENTS.join(", ")}`,
        ),
      );
    }
  }

  if (record.confidence !== undefined) {
    if (
      typeof record.confidence !== "number" ||
      !Number.isFinite(record.confidence) ||
      record.confidence < 0 ||
      record.confidence > 1
    ) {
      return err(new ProvenanceValidationError("confidence must be a number between 0 and 1"));
    }
  }

  return ok(record);
}
