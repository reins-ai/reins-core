export type MemoryType = "fact" | "preference" | "context" | "note";

export interface MemoryEntry {
  id: string;
  content: string;
  type: MemoryType;
  tags: string[];
  importance: number;
  conversationId?: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt?: Date;
}

export interface MemorySearchOptions {
  query?: string;
  tags?: string[];
  type?: MemoryEntry["type"];
  minImportance?: number;
  limit?: number;
  includeExpired?: boolean;
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}
