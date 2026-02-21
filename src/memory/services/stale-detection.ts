import type { MemoryRecord } from "../types/memory-record";

/**
 * Configuration for stale memory detection.
 */
export interface StaleDetectionConfig {
  /** Number of days after which a memory is considered stale. */
  thresholdDays: number;
}

const DEFAULT_THRESHOLD_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Determines whether a memory record is stale based on its `accessedAt` date.
 *
 * A record is stale when it has not been accessed within `thresholdDays` of the
 * current time. The comparison is inclusive — a record accessed exactly
 * `thresholdDays` ago is considered stale. A record with a future `accessedAt`
 * date is never stale.
 */
export function isStale(
  record: MemoryRecord,
  thresholdDays: number = DEFAULT_THRESHOLD_DAYS,
): boolean {
  const now = Date.now();
  const accessedMs = record.accessedAt.getTime();
  const elapsedMs = now - accessedMs;
  const thresholdMs = thresholdDays * MS_PER_DAY;

  return elapsedMs >= thresholdMs;
}

/**
 * Filters an array of memory records, returning only those that are stale.
 *
 * Preserves the original array order and does not mutate the input.
 * Returns an empty array when given an empty input.
 */
export function getStaleMemories(
  records: MemoryRecord[],
  thresholdDays: number = DEFAULT_THRESHOLD_DAYS,
): MemoryRecord[] {
  return records.filter((record) => isStale(record, thresholdDays));
}
