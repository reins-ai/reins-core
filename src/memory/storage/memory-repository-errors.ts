import { ReinsError } from "../../errors";

export const MEMORY_REPOSITORY_ERROR_CODES = [
  "MEMORY_REPOSITORY_INVALID_INPUT",
  "MEMORY_REPOSITORY_NOT_FOUND",
  "MEMORY_REPOSITORY_IO_ERROR",
  "MEMORY_REPOSITORY_DB_ERROR",
  "MEMORY_REPOSITORY_SERIALIZATION_ERROR",
  "MEMORY_REPOSITORY_RECONCILIATION_ERROR",
] as const;

export type MemoryRepositoryErrorCode = (typeof MEMORY_REPOSITORY_ERROR_CODES)[number];

export class MemoryRepositoryError extends ReinsError {
  constructor(message: string, code: MemoryRepositoryErrorCode, cause?: Error) {
    super(message, code, cause);
    this.name = "MemoryRepositoryError";
  }
}
