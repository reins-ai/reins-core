export interface EmbeddingProviderConfig {
  provider: string;
  model: string;
}

export interface MemoryConfig {
  embedding?: EmbeddingProviderConfig;
  updatedAt?: string;
}

export type MemoryCapabilityFeature = "crud" | "semanticSearch" | "consolidation";

export interface MemoryCapabilityState {
  enabled: boolean;
  reason?: string;
}

export interface MemoryCapabilities {
  embeddingConfigured: boolean;
  setupRequired: boolean;
  configPath: string;
  features: Record<MemoryCapabilityFeature, MemoryCapabilityState>;
  embedding?: EmbeddingProviderConfig;
}
