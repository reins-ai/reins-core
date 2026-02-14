import type { MemoryRecord } from "../types/index";

export const CONSOLIDATION_CANDIDATE_STATUSES = [
  "eligible",
  "processing",
  "consolidated",
  "failed",
  "skipped",
] as const;

export type ConsolidationCandidateStatus =
  (typeof CONSOLIDATION_CANDIDATE_STATUSES)[number];

export interface BatchConfig {
  batchSize: number;
  dedupeWindowMs: number;
  maxRetries: number;
  minAgeMs: number;
}

export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  batchSize: 20,
  dedupeWindowMs: 30 * 60 * 1000,
  maxRetries: 3,
  minAgeMs: 5 * 60 * 1000,
};

export interface ConsolidationCandidate {
  record: MemoryRecord;
  status: ConsolidationCandidateStatus;
  retryCount: number;
  lastAttemptAt?: Date;
  batchId?: string;
}

export interface StmBatch {
  batchId: string;
  candidates: ConsolidationCandidate[];
  createdAt: Date;
}
