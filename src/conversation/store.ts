import type { Conversation, ConversationSummary } from "../types";

export interface ListOptions {
  workspaceId?: string;
  limit?: number;
  offset?: number;
  orderBy?: "created" | "updated";
}

export interface ConversationStore {
  save(conversation: Conversation): Promise<void>;
  load(id: string): Promise<Conversation | null>;
  list(options?: ListOptions): Promise<ConversationSummary[]>;
  delete(id: string): Promise<boolean>;
  exists(id: string): Promise<boolean>;
  updateTitle(id: string, title: string): Promise<void>;
}
