import { ReinsError } from "../../errors";

export const MEMORY_ERROR_CODES = [
  "MEMORY_INIT_FAILED",
  "MEMORY_NOT_READY",
  "MEMORY_SHUTDOWN_FAILED",
  "MEMORY_DB_ERROR",
  "MEMORY_EXPORT_FAILED",
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

export class MemoryError extends ReinsError {
  constructor(message: string, code: MemoryErrorCode, cause?: Error) {
    super(message, code, cause);
    this.name = "MemoryError";
  }
}
