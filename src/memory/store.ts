import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "./types";

export interface MemoryStore {
  save(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry>;
  get(id: string): Promise<MemoryEntry | null>;
  search(options: MemorySearchOptions): Promise<MemorySearchResult[]>;
  update(
    id: string,
    updates: Partial<Pick<MemoryEntry, "content" | "tags" | "importance" | "expiresAt">>,
  ): Promise<MemoryEntry | null>;
  delete(id: string): Promise<boolean>;
  deleteByConversation(conversationId: string): Promise<number>;
  clear(): Promise<void>;
}
