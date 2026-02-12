import type { ConversationError } from "../errors";
import type { Result } from "../result";
import type { Conversation, ConversationSummary } from "../types";

export interface ListOptions {
  workspaceId?: string;
  limit?: number;
  offset?: number;
  orderBy?: "created" | "updated";
}

export type ConversationStoreResult<T> = Result<T, ConversationError>;

export interface ConversationStore {
  save(conversation: Conversation): Promise<ConversationStoreResult<void>>;
  load(id: string): Promise<ConversationStoreResult<Conversation | null>>;
  list(options?: ListOptions): Promise<ConversationStoreResult<ConversationSummary[]>>;
  delete(id: string): Promise<ConversationStoreResult<boolean>>;
  exists(id: string): Promise<ConversationStoreResult<boolean>>;
  updateTitle(id: string, title: string): Promise<ConversationStoreResult<void>>;
}
