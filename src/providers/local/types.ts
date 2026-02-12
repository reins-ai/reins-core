import type { ProviderConfig } from "../../types/provider";

export interface LocalProviderConfig extends ProviderConfig {
  baseUrl: string;
  timeout?: number;
  healthCheckInterval?: number;
}

export interface ProviderHealth {
  status: "available" | "unavailable" | "unknown";
  lastChecked: Date;
  latencyMs?: number;
  error?: string;
}

export interface PerformanceMetrics {
  tokensPerSecond: number;
  latencyMs: number;
  modelId: string;
  timestamp: Date;
}
