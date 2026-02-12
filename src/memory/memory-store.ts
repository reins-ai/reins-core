import { generateId } from "../conversation/id";
import { searchMemories } from "./search";
import type { MemoryStore } from "./store";
import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "./types";

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return structuredClone(entry);
}

function normalizeImportance(importance: number): number {
  return Math.min(1, Math.max(0, importance));
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly entries = new Map<string, MemoryEntry>();

  async save(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry> {
    const now = new Date();
    const nextEntry: MemoryEntry = {
      ...entry,
      id: generateId("mem"),
      tags: normalizeTags(entry.tags),
      importance: normalizeImportance(entry.importance),
      createdAt: now,
      updatedAt: now,
      expiresAt: entry.expiresAt,
    };

    this.entries.set(nextEntry.id, cloneEntry(nextEntry));
    return cloneEntry(nextEntry);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }

    return cloneEntry(entry);
  }

  async search(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    const results = searchMemories(Array.from(this.entries.values()), options);

    return results.map((result) => ({
      entry: cloneEntry(result.entry),
      score: result.score,
    }));
  }

  async update(
    id: string,
    updates: Partial<Pick<MemoryEntry, "content" | "tags" | "importance" | "expiresAt">>,
  ): Promise<MemoryEntry | null> {
    const existing = this.entries.get(id);
    if (!existing) {
      return null;
    }

    const updated: MemoryEntry = {
      ...existing,
      content: updates.content ?? existing.content,
      tags: updates.tags ? normalizeTags(updates.tags) : existing.tags,
      importance:
        typeof updates.importance === "number"
          ? normalizeImportance(updates.importance)
          : existing.importance,
      expiresAt: updates.expiresAt ?? existing.expiresAt,
      updatedAt: new Date(),
    };

    this.entries.set(id, cloneEntry(updated));
    return cloneEntry(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async deleteByConversation(conversationId: string): Promise<number> {
    let deleted = 0;

    for (const [id, entry] of this.entries.entries()) {
      if (entry.conversationId === conversationId) {
        this.entries.delete(id);
        deleted += 1;
      }
    }

    return deleted;
  }

  async clear(): Promise<void> {
    this.entries.clear();
  }
}
