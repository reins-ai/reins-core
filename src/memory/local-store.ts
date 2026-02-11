import { mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

import { generateId } from "../conversation/id";
import { ConversationError } from "../errors";
import { err, ok, type Result } from "../result";
import { searchMemories } from "./search";
import type { MemoryStore } from "./store";
import type { MemoryEntry, MemorySearchOptions, MemorySearchResult } from "./types";

interface SerializedMemoryEntry {
  id: string;
  content: string;
  type: MemoryEntry["type"];
  tags: string[];
  importance: number;
  conversationId?: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
  return structuredClone(entry);
}

function normalizeImportance(importance: number): number {
  return Math.min(1, Math.max(0, importance));
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function serializeEntries(entries: Iterable<MemoryEntry>): SerializedMemoryEntry[] {
  return Array.from(entries).map((entry) => ({
    id: entry.id,
    content: entry.content,
    type: entry.type,
    tags: [...entry.tags],
    importance: entry.importance,
    conversationId: entry.conversationId,
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
    expiresAt: entry.expiresAt?.toISOString(),
  }));
}

function deserializeEntries(serialized: SerializedMemoryEntry[]): MemoryEntry[] {
  return serialized.map((entry) => ({
    id: entry.id,
    content: entry.content,
    type: entry.type,
    tags: [...entry.tags],
    importance: normalizeImportance(entry.importance),
    conversationId: entry.conversationId,
    createdAt: new Date(entry.createdAt),
    updatedAt: new Date(entry.updatedAt),
    expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : undefined,
  }));
}

export class LocalFileMemoryStore implements MemoryStore {
  private readonly filePath: string;
  private readonly entries = new Map<string, MemoryEntry>();
  private loaded = false;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async save(entry: Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">): Promise<MemoryEntry> {
    await this.ensureLoaded();

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
    await this.persist();
    return cloneEntry(nextEntry);
  }

  async get(id: string): Promise<MemoryEntry | null> {
    await this.ensureLoaded();

    const entry = this.entries.get(id);
    if (!entry) {
      return null;
    }

    return cloneEntry(entry);
  }

  async search(options: MemorySearchOptions): Promise<MemorySearchResult[]> {
    await this.ensureLoaded();

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
    await this.ensureLoaded();

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
    await this.persist();
    return cloneEntry(updated);
  }

  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();

    const deleted = this.entries.delete(id);
    if (deleted) {
      await this.persist();
    }

    return deleted;
  }

  async deleteByConversation(conversationId: string): Promise<number> {
    await this.ensureLoaded();

    let deleted = 0;
    for (const [id, entry] of this.entries.entries()) {
      if (entry.conversationId === conversationId) {
        this.entries.delete(id);
        deleted += 1;
      }
    }

    if (deleted > 0) {
      await this.persist();
    }

    return deleted;
  }

  async clear(): Promise<void> {
    await this.ensureLoaded();
    this.entries.clear();
    await this.persist();
  }

  async persistNow(): Promise<Result<void, ConversationError>> {
    try {
      await this.ensureLoaded();
      await this.persist();
      return ok(undefined);
    } catch (cause) {
      return err(this.asConversationError("Failed to persist memory store", cause));
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) {
      return;
    }

    this.loaded = true;

    const file = Bun.file(this.filePath);
    if (!(await file.exists())) {
      return;
    }

    const content = (await file.text()).trim();
    if (!content) {
      return;
    }

    const parsed = JSON.parse(content) as SerializedMemoryEntry[];
    const entries = deserializeEntries(parsed);

    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
    }
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });

    const serialized = serializeEntries(this.entries.values());
    const payload = JSON.stringify(serialized, null, 2);
    const tempPath = `${this.filePath}.tmp-${crypto.randomUUID()}`;

    await Bun.write(tempPath, payload);
    await rename(tempPath, this.filePath);
  }

  private asConversationError(message: string, cause: unknown): ConversationError {
    if (cause instanceof ConversationError) {
      return cause;
    }

    return new ConversationError(message, cause instanceof Error ? cause : undefined);
  }
}
