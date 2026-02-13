import type { Result } from "../result";
import type { MemoryType } from "../memory/types/index";

export interface TurnContextParams {
  query: string;
  conversationId: string;
  maxTokenBudget?: number;
  maxItems?: number;
  excludeIds?: string[];
}

export interface PrimingContext {
  memories: MemoryPrimingItem[];
  totalTokenEstimate: number;
  truncated: boolean;
}

export interface MemoryPrimingItem {
  id: string;
  content: string;
  type: MemoryType;
  importance: number;
  relevanceScore: number;
  source: string;
  tokenEstimate: number;
}

export interface PreferenceOptions {
  limit?: number;
  minImportance?: number;
}

export interface MemoryPrimingContract {
  getContextForTurn(params: TurnContextParams): Promise<Result<PrimingContext>>;
  getUserPreferences(options?: PreferenceOptions): Promise<Result<MemoryPrimingItem[]>>;
}
