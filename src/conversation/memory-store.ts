import type { Conversation, ConversationSummary } from "../types";
import type { ConversationStore, ListOptions } from "./store";

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  async save(conversation: Conversation): Promise<void> {
    this.conversations.set(conversation.id, structuredClone(conversation));
  }

  async load(id: string): Promise<Conversation | null> {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      return null;
    }

    return structuredClone(conversation);
  }

  async list(options?: ListOptions): Promise<ConversationSummary[]> {
    const orderBy = options?.orderBy ?? "updated";
    const offset = Math.max(0, options?.offset ?? 0);
    const limit = options?.limit;

    const filtered = Array.from(this.conversations.values()).filter((conversation) => {
      if (!options?.workspaceId) {
        return true;
      }

      return conversation.workspaceId === options.workspaceId;
    });

    filtered.sort((a, b) => {
      const left = orderBy === "created" ? a.createdAt.getTime() : a.updatedAt.getTime();
      const right = orderBy === "created" ? b.createdAt.getTime() : b.updatedAt.getTime();
      return right - left;
    });

    const paginated =
      typeof limit === "number"
        ? filtered.slice(offset, offset + Math.max(0, limit))
        : filtered.slice(offset);

    return paginated.map((conversation) => {
      const lastMessage = conversation.messages[conversation.messages.length - 1];

      return {
        id: conversation.id,
        title: conversation.title,
        model: conversation.model,
        messageCount: conversation.messages.length,
        lastMessageAt: lastMessage?.createdAt ?? conversation.updatedAt,
        createdAt: conversation.createdAt,
      } satisfies ConversationSummary;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.conversations.delete(id);
  }

  async exists(id: string): Promise<boolean> {
    return this.conversations.has(id);
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      return;
    }

    conversation.title = title;
    conversation.updatedAt = new Date();
  }
}
