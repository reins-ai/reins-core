import { ConversationError } from "../errors";
import type { MemoryStore } from "../memory";
import { err, ok, type Result } from "../result";
import type { Conversation, Message, MessageRole } from "../types";
import { CompactionService } from "./compaction";
import { generateId } from "./id";
import type { SessionMetadata, SessionNewOptions, SessionRepository } from "./session-repository";
import type { ConversationStore, ListOptions } from "./store";
import { TranscriptStore } from "./transcript-store";

export interface CreateOptions {
  title?: string;
  model: string;
  provider: string;
  personaId?: string;
  workspaceId?: string;
  systemPrompt?: string;
}

export interface HistoryOptions {
  limit?: number;
  before?: Date;
  roles?: MessageRole[];
}

export interface ForkOptions {
  upToMessageId?: string;
  title?: string;
}

export interface StartNewSessionOptions extends SessionNewOptions {}

export interface ConversationManagerCompactionOptions {
  compactionService: CompactionService;
  memoryStore: MemoryStore;
  transcriptStore: TranscriptStore;
}

export class ConversationManager {
  private readonly compactionOptions?: ConversationManagerCompactionOptions;

  constructor(
    private readonly store: ConversationStore,
    private readonly sessionRepository?: SessionRepository,
    compactionOptions?: ConversationManagerCompactionOptions,
  ) {
    this.compactionOptions = compactionOptions;
  }

  async create(options: CreateOptions): Promise<Conversation> {
    const now = new Date();
    const messages: Message[] = [];

    if (options.systemPrompt) {
      messages.push({
        id: generateId("msg"),
        role: "system",
        content: options.systemPrompt,
        createdAt: now,
      });
    }

    const conversation: Conversation = {
      id: generateId("conv"),
      title: options.title?.trim() || "New Conversation",
      messages,
      model: options.model,
      provider: options.provider,
      personaId: options.personaId,
      workspaceId: options.workspaceId,
      createdAt: now,
      updatedAt: now,
    };

    await this.store.save(conversation);
    return conversation;
  }

  async load(id: string): Promise<Conversation> {
    const conversation = await this.store.load(id);

    if (!conversation) {
      throw new ConversationError(`Conversation not found: ${id}`);
    }

    return conversation;
  }

  async addMessage(
    conversationId: string,
    message: Omit<Message, "id" | "createdAt">,
  ): Promise<Message> {
    const conversation = await this.load(conversationId);

    const nextMessage: Message = {
      ...message,
      id: generateId("msg"),
      createdAt: new Date(),
    };

    conversation.messages.push(nextMessage);
    conversation.updatedAt = new Date();

    await this.store.save(conversation);

    const compactionResult = await this.runCompactionIfNeeded(conversation);
    if (!compactionResult.ok) {
      throw compactionResult.error;
    }

    return nextMessage;
  }

  async getHistory(conversationId: string, options?: HistoryOptions): Promise<Message[]> {
    const conversation = await this.load(conversationId);

    let messages = conversation.messages;

    if (options?.before) {
      const beforeTs = options.before.getTime();
      messages = messages.filter((message) => message.createdAt.getTime() < beforeTs);
    }

    if (options?.roles && options.roles.length > 0) {
      const roles = new Set(options.roles);
      messages = messages.filter((message) => roles.has(message.role));
    }

    if (typeof options?.limit === "number") {
      messages = messages.slice(-Math.max(0, options.limit));
    }

    return messages;
  }

  async list(options?: ListOptions) {
    return this.store.list(options);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async fork(conversationId: string, options?: ForkOptions): Promise<Conversation> {
    const source = await this.load(conversationId);
    const now = new Date();
    const copiedMessages = this.copyMessagesForFork(source, options);

    const conversation: Conversation = {
      id: generateId("conv"),
      title: options?.title?.trim() || `${source.title} (Fork)`,
      messages: copiedMessages,
      model: source.model,
      provider: source.provider,
      personaId: source.personaId,
      workspaceId: source.workspaceId,
      createdAt: now,
      updatedAt: now,
      metadata: source.metadata ? structuredClone(source.metadata) : undefined,
    };

    await this.store.save(conversation);
    return conversation;
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const normalized = title.trim();
    if (!normalized) {
      throw new ConversationError("Conversation title cannot be empty");
    }

    const exists = await this.store.exists(id);
    if (!exists) {
      throw new ConversationError(`Conversation not found: ${id}`);
    }

    await this.store.updateTitle(id, normalized);
  }

  async resumeMain(): Promise<Result<SessionMetadata, ConversationError>> {
    if (!this.sessionRepository) {
      return err(new ConversationError("Session repository is not configured"));
    }

    return this.sessionRepository.getMain();
  }

  async startNewSession(
    options: StartNewSessionOptions,
  ): Promise<Result<SessionMetadata, ConversationError>> {
    if (!this.sessionRepository) {
      return err(new ConversationError("Session repository is not configured"));
    }

    const result = await this.sessionRepository.newSession(options);
    if (!result.ok) {
      return result;
    }

    return ok(result.value);
  }

  generateTitle(conversation: Conversation): string {
    const firstUserMessage = conversation.messages.find((message) => message.role === "user");
    if (!firstUserMessage) {
      return "New Conversation";
    }

    return firstUserMessage.content.trim().slice(0, 50) || "New Conversation";
  }

  private copyMessagesForFork(source: Conversation, options?: ForkOptions): Message[] {
    const messages = source.messages;
    let endIndex = messages.length;

    if (options?.upToMessageId) {
      const index = messages.findIndex((message) => message.id === options.upToMessageId);
      if (index === -1) {
        throw new ConversationError(
          `Cannot fork conversation: message not found: ${options.upToMessageId}`,
        );
      }

      endIndex = index + 1;
    }

    return messages.slice(0, endIndex).map((message) => ({
      ...message,
      id: generateId("msg"),
      metadata: message.metadata ? structuredClone(message.metadata) : undefined,
      toolCalls: message.toolCalls ? structuredClone(message.toolCalls) : undefined,
    }));
  }

  private async runCompactionIfNeeded(
    conversation: Conversation,
  ): Promise<Result<SessionMetadata | null, ConversationError>> {
    if (!this.sessionRepository || !this.compactionOptions) {
      return ok(null);
    }

    const mainSessionResult = await this.sessionRepository.getMain();
    if (!mainSessionResult.ok) {
      return mainSessionResult;
    }

    const session = mainSessionResult.value;
    const shouldCompactResult = this.compactionOptions.compactionService.shouldCompact(
      session,
      conversation,
    );
    if (!shouldCompactResult.ok) {
      return shouldCompactResult;
    }

    if (!shouldCompactResult.value) {
      return ok(session);
    }

    const compactResult = await this.compactionOptions.compactionService.compact(
      session,
      conversation,
      this.compactionOptions.memoryStore,
      this.compactionOptions.transcriptStore,
      this.sessionRepository,
      this.store,
    );
    if (!compactResult.ok) {
      return compactResult;
    }

    return ok(compactResult.value.session ?? session);
  }
}
