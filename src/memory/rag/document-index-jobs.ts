export const INDEX_JOB_STATUSES = ["pending", "running", "complete", "failed"] as const;

export type IndexJobStatus = (typeof INDEX_JOB_STATUSES)[number];

export interface IndexJob {
  id: string;
  sourceId: string;
  status: IndexJobStatus;
  startedAt?: string;
  completedAt?: string;
  chunksProcessed: number;
  chunksTotal: number;
  embeddingsGenerated: number;
  errors: string[];
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDimensions: number;
}

export interface IndexBatchConfig {
  batchSize: number;
  maxConcurrent: number;
  retryAttempts: number;
  retryDelayMs: number;
}

export const DEFAULT_BATCH_CONFIG: IndexBatchConfig = {
  batchSize: 10,
  maxConcurrent: 5,
  retryAttempts: 2,
  retryDelayMs: 1000,
};
