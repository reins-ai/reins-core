import type { MemoryRecord } from "./memory-record";

export const MEMORY_EVENT_TYPES = ["created", "updated", "deleted"] as const;

export type MemoryEventType = (typeof MEMORY_EVENT_TYPES)[number];

export interface MemoryEvent {
  type: MemoryEventType;
  record: MemoryRecord;
  timestamp: Date;
}

export type OnMemoryEvent = (event: MemoryEvent) => void;
