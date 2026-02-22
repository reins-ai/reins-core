import type { ConflictResolution, ConflictStrategy } from "../types";

/**
 * Shared types for all OpenClaw → Reins data mappers.
 */

/**
 * Describes a single mapping failure for a specific item.
 */
export interface MapError {
  item: string;
  reason: string;
}

/**
 * Aggregated result returned by every mapper after processing a batch.
 */
export interface MapResult {
  converted: number;
  skipped: number;
  errors: MapError[];
}

/**
 * Options shared across all mappers.
 */
export interface MapperOptions {
  dryRun?: boolean;
  onProgress?: (processed: number, total: number) => void;
  conflictStrategy?: ConflictStrategy;
  conflicts?: ConflictResolution[];
}
