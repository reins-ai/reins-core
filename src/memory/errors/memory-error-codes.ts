import type { Result } from "../../result";
import { err } from "../../result";
import {
  MemoryError,
  type MemoryErrorCode,
} from "../services/memory-error";

export const MEMORY_SYSTEM_ERROR_CODES = [
  "MEMORY_STORAGE_WRITE_FAILED",
  "MEMORY_STORAGE_READ_FAILED",
  "MEMORY_SEARCH_FAILED",
  "MEMORY_EMBEDDING_FAILED",
  "MEMORY_CONSOLIDATION_FAILED",
  "MEMORY_DISTILLATION_FAILED",
  "MEMORY_MERGE_CONFLICT",
  "MEMORY_REINDEX_FAILED",
  "MEMORY_PROVIDER_UNAVAILABLE",
  "MEMORY_QUOTA_EXCEEDED",
] as const;

export type MemorySystemErrorCode = (typeof MEMORY_SYSTEM_ERROR_CODES)[number];

export type MemoryErrorSeverity = "recoverable" | "fatal";

export interface MemoryErrorCodeMetadata {
  description: string;
  severity: MemoryErrorSeverity;
}

export const MEMORY_ERROR_CODE_METADATA: Record<
  MemorySystemErrorCode,
  MemoryErrorCodeMetadata
> = {
  MEMORY_STORAGE_WRITE_FAILED: {
    description: "Failed to persist memory state to SQLite or markdown storage.",
    severity: "fatal",
  },
  MEMORY_STORAGE_READ_FAILED: {
    description: "Failed to read memory state from SQLite or markdown storage.",
    severity: "recoverable",
  },
  MEMORY_SEARCH_FAILED: {
    description: "Hybrid memory search operation failed.",
    severity: "recoverable",
  },
  MEMORY_EMBEDDING_FAILED: {
    description: "Embedding generation or embedding pipeline failed.",
    severity: "recoverable",
  },
  MEMORY_CONSOLIDATION_FAILED: {
    description: "Memory consolidation pipeline failed to complete.",
    severity: "fatal",
  },
  MEMORY_DISTILLATION_FAILED: {
    description: "Distillation step returned malformed or unusable output.",
    severity: "recoverable",
  },
  MEMORY_MERGE_CONFLICT: {
    description: "Merge phase encountered an unrecoverable conflict.",
    severity: "fatal",
  },
  MEMORY_REINDEX_FAILED: {
    description: "Embedding reindex operation failed before completion.",
    severity: "recoverable",
  },
  MEMORY_PROVIDER_UNAVAILABLE: {
    description: "Memory provider is temporarily unavailable.",
    severity: "recoverable",
  },
  MEMORY_QUOTA_EXCEEDED: {
    description: "Memory storage quota has been exceeded.",
    severity: "recoverable",
  },
};

export function getMemoryErrorMetadata(
  code: MemorySystemErrorCode,
): MemoryErrorCodeMetadata {
  return MEMORY_ERROR_CODE_METADATA[code];
}

export interface CreateMemoryErrorOptions {
  message?: string;
  cause?: Error;
}

export function createMemoryErrorFromCode(
  code: MemorySystemErrorCode,
  options?: CreateMemoryErrorOptions,
): MemoryError {
  const metadata = getMemoryErrorMetadata(code);
  const message = options?.message ?? metadata.description;

  return new MemoryError(
    message,
    code as unknown as MemoryErrorCode,
    options?.cause,
  );
}

export function errFromMemoryCode<T>(
  code: MemorySystemErrorCode,
  options?: CreateMemoryErrorOptions,
): Result<T, MemoryError> {
  return err(createMemoryErrorFromCode(code, options));
}
