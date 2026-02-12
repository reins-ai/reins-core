import { ok } from "../result";
import type { Conversation, ConversationSummary } from "../types";
import type { ConversationStore, ListOptions } from "./store";

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();

  async save(conversation: Conversation) {
    this.conversations.set(conversation.id, structuredClone(conversation));
    return ok(undefined);
  }

  async load(id: string) {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      return ok(null);
    }

    return ok(structuredClone(conversation));
  }

  async list(options?: ListOptions) {
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

    const summaries = paginated.map((conversation) => {
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

    return ok(summaries);
  }

  async delete(id: string) {
    return ok(this.conversations.delete(id));
  }

  async exists(id: string) {
    return ok(this.conversations.has(id));
  }

  async updateTitle(id: string, title: string) {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      return ok(undefined);
    }

    conversation.title = title;
    conversation.updatedAt = new Date();
    return ok(undefined);
  }
}
