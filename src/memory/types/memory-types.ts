export const MEMORY_TYPES = [
  "fact",
  "preference",
  "decision",
  "episode",
  "skill",
  "entity",
  "document_chunk",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_LAYERS = ["working", "stm", "ltm"] as const;

export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export const PERSISTED_MEMORY_LAYERS = ["stm", "ltm"] as const;

export type PersistedMemoryLayer = (typeof PERSISTED_MEMORY_LAYERS)[number];

export const MEMORY_SOURCE_TYPES = [
  "explicit",
  "implicit",
  "compaction",
  "consolidation",
  "document",
] as const;

export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export interface MemoryImportanceSignals {
  baseImportance: number;
  accessCount: number;
  reinforcementCount: number;
  decayFactor: number;
  lastAccessedAt: Date;
}

export function isValidMemoryType(value: string): value is MemoryType {
  return MEMORY_TYPES.includes(value as MemoryType);
}

export function isValidMemoryLayer(value: string): value is MemoryLayer {
  return MEMORY_LAYERS.includes(value as MemoryLayer);
}

export function isValidPersistedMemoryLayer(value: string): value is PersistedMemoryLayer {
  return PERSISTED_MEMORY_LAYERS.includes(value as PersistedMemoryLayer);
}

export function isValidMemorySourceType(value: string): value is MemorySourceType {
  return MEMORY_SOURCE_TYPES.includes(value as MemorySourceType);
}
