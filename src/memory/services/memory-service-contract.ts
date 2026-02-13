import type { Result } from "../../result";

export interface MemoryHealthStatus {
  dbConnected: boolean;
  memoryCount: number;
  lastConsolidation?: Date;
  embeddingProvider?: string;
}

export interface MemoryServiceContract {
  initialize(): Promise<Result<void>>;
  shutdown(): Promise<Result<void>>;
  isReady(): boolean;
  healthCheck(): Promise<Result<MemoryHealthStatus>>;
}
