import { ConversationError } from "../errors";
import type { MemoryStore } from "../memory";
import type { EnvironmentContextProvider } from "../persona/environment-context";
import type { PersonaRegistry } from "../persona/registry";
import { err, ok, type Result } from "../result";
import type {
  ContentBlock,
  Conversation,
  Message,
  MessageRole,
  ToolResultBlock,
  ToolUseBlock,
} from "../types";
import { CompactionService } from "./compaction";
import type { CompactionManager } from "./compaction/compaction-manager";
import type { CompactionContext } from "./compaction/memory-preservation-hook";
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

export interface SendMessageOptions {
  conversationId?: string;
  content: string;
  model?: string;
  provider?: string;
}

export interface SendMessageResult {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  timestamp: Date;
}

export interface CompleteAssistantMessageOptions {
  conversationId: string;
  assistantMessageId: string;
  content: string | ContentBlock[];
  provider: string;
  model: string;
  finishReason?: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

export interface FailAssistantMessageOptions {
  conversationId: string;
  assistantMessageId: string;
  errorCode: string;
  errorMessage: string;
  provider?: string;
  model?: string;
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

export interface CompactionMemoryWriteThrough {
  compactionManager: CompactionManager;
  logger?: CompactionMemoryLogger;
}

export interface CompactionMemoryLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface ConversationManagerCompactionOptions {
  compactionService: CompactionService;
  memoryStore: MemoryStore;
  transcriptStore: TranscriptStore;
  memoryWriteThrough?: CompactionMemoryWriteThrough;
}

export interface ConversationManagerEnvironmentOptions {
  personaRegistry?: PersonaRegistry;
  environmentContextProvider?: EnvironmentContextProvider;
}

export class ConversationManager {
  private readonly compactionOptions?: ConversationManagerCompactionOptions;
  private readonly environmentOptions?: ConversationManagerEnvironmentOptions;

  constructor(
    private readonly store: ConversationStore,
    private readonly sessionRepository?: SessionRepository,
    compactionOptions?: ConversationManagerCompactionOptions,
    environmentOptions?: ConversationManagerEnvironmentOptions,
  ) {
    this.compactionOptions = compactionOptions;
    this.environmentOptions = environmentOptions;
  }

  async create(options: CreateOptions): Promise<Conversation> {
    const now = new Date();
    const messages: Message[] = [];
    const hasExplicitSystemPrompt = Object.prototype.hasOwnProperty.call(options, "systemPrompt");
    const environmentSystemPrompt = hasExplicitSystemPrompt
      ? undefined
      : await this.buildEnvironmentSystemPrompt(options.personaId);
    const systemPrompt = hasExplicitSystemPrompt ? options.systemPrompt : environmentSystemPrompt;

    if (typeof systemPrompt === "string") {
      messages.push({
        id: generateId("msg"),
        role: "system",
        content: systemPrompt,
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

    const saveResult = await this.store.save(conversation);
    if (!saveResult.ok) {
      throw saveResult.error;
    }

    return conversation;
  }

  async load(id: string): Promise<Conversation> {
    const loadResult = await this.store.load(id);
    if (!loadResult.ok) {
      throw loadResult.error;
    }

    const conversation = loadResult.value;

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

    const saveResult = await this.store.save(conversation);
    if (!saveResult.ok) {
      throw saveResult.error;
    }

    const compactionResult = await this.runCompactionIfNeeded(conversation);
    if (!compactionResult.ok) {
      throw compactionResult.error;
    }

    return nextMessage;
  }

  async addToolUseMessage(
    conversationId: string,
    toolUseBlocks: ToolUseBlock[],
    textPrefix?: string,
  ): Promise<Message> {
    const blocks: ContentBlock[] = [];

    if (textPrefix) {
      blocks.push({ type: "text", text: textPrefix });
    }

    blocks.push(...toolUseBlocks);

    return this.addMessage(conversationId, {
      role: "assistant",
      content: blocks,
    });
  }

  async addToolResult(
    conversationId: string,
    toolUseId: string,
    content: string,
    isError?: boolean,
  ): Promise<Message> {
    const resultBlock: ToolResultBlock = {
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
      ...(isError ? { is_error: true } : {}),
    };

    return this.addMessage(conversationId, {
      role: "user",
      content: [resultBlock],
    });
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
    const listResult = await this.store.list(options);
    if (!listResult.ok) {
      throw listResult.error;
    }

    return listResult.value;
  }

  async delete(id: string): Promise<boolean> {
    const deleteResult = await this.store.delete(id);
    if (!deleteResult.ok) {
      throw deleteResult.error;
    }

    return deleteResult.value;
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

    const saveResult = await this.store.save(conversation);
    if (!saveResult.ok) {
      throw saveResult.error;
    }

    return conversation;
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const normalized = title.trim();
    if (!normalized) {
      throw new ConversationError("Conversation title cannot be empty");
    }

    const existsResult = await this.store.exists(id);
    if (!existsResult.ok) {
      throw existsResult.error;
    }

    if (!existsResult.value) {
      throw new ConversationError(`Conversation not found: ${id}`);
    }

    const updateResult = await this.store.updateTitle(id, normalized);
    if (!updateResult.ok) {
      throw updateResult.error;
    }
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

  /**
   * Persist a user message and create a placeholder assistant message.
   * If no conversationId is provided, a new conversation is created first.
   * Returns IDs and timestamp immediately — no provider invocation happens here.
   */
  async sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    const model = options.model ?? "claude-sonnet-4-20250514";
    const provider = options.provider ?? "anthropic";
    const now = new Date();

    // Resolve or create conversation
    let conversationId: string;
    if (options.conversationId) {
      // Verify the conversation exists (throws ConversationError if not found)
      const conversation = await this.load(options.conversationId);
      await this.syncEnvironmentSystemPrompt(conversation);
      conversationId = options.conversationId;
    } else {
      const conversation = await this.create({
        title: options.content.trim().slice(0, 50) || "New Conversation",
        model,
        provider,
      });
      conversationId = conversation.id;
    }

    // Persist user message
    const userMessage = await this.addMessage(conversationId, {
      role: "user",
      content: options.content,
    });

    // Create placeholder assistant message (empty content, pending completion)
    const assistantMessage = await this.addMessage(conversationId, {
      role: "assistant",
      content: "",
      metadata: {
        provider,
        model,
        status: "pending",
      },
    });

    return {
      conversationId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      timestamp: now,
    };
  }

  async getEnvironmentSystemPrompt(personaId?: string): Promise<string | undefined> {
    return this.buildEnvironmentSystemPrompt(personaId);
  }

  async completeAssistantMessage(options: CompleteAssistantMessageOptions): Promise<void> {
    const conversation = await this.load(options.conversationId);
    const assistantMessage = conversation.messages.find((message) => message.id === options.assistantMessageId);

    if (!assistantMessage) {
      throw new ConversationError(`Assistant message not found: ${options.assistantMessageId}`);
    }

    if (assistantMessage.role !== "assistant") {
      throw new ConversationError(
        `Cannot complete non-assistant message: ${options.assistantMessageId} (${assistantMessage.role})`,
      );
    }

    assistantMessage.content = options.content;
    assistantMessage.metadata = {
      ...(assistantMessage.metadata ?? {}),
      provider: options.provider,
      model: options.model,
      status: "complete",
      completedAt: new Date().toISOString(),
      ...(options.finishReason ? { finishReason: options.finishReason } : {}),
      ...(options.usage ? { usage: options.usage } : {}),
    };

    conversation.updatedAt = new Date();
    const saveResult = await this.store.save(conversation);
    if (!saveResult.ok) {
      throw saveResult.error;
    }
  }

  async failAssistantMessage(options: FailAssistantMessageOptions): Promise<void> {
    const conversation = await this.load(options.conversationId);
    const assistantMessage = conversation.messages.find((message) => message.id === options.assistantMessageId);

    if (!assistantMessage) {
      throw new ConversationError(`Assistant message not found: ${options.assistantMessageId}`);
    }

    if (assistantMessage.role !== "assistant") {
      throw new ConversationError(
        `Cannot fail non-assistant message: ${options.assistantMessageId} (${assistantMessage.role})`,
      );
    }

    assistantMessage.metadata = {
      ...(assistantMessage.metadata ?? {}),
      ...(options.provider ? { provider: options.provider } : {}),
      ...(options.model ? { model: options.model } : {}),
      status: "error",
      errorCode: options.errorCode,
      errorMessage: options.errorMessage,
      failedAt: new Date().toISOString(),
    };

    conversation.updatedAt = new Date();
    const saveResult = await this.store.save(conversation);
    if (!saveResult.ok) {
      throw saveResult.error;
    }
  }

  generateTitle(conversation: Conversation): string {
    const firstUserMessage = conversation.messages.find((message) => message.role === "user");
    if (!firstUserMessage) {
      return "New Conversation";
    }

    const text = this.extractTextContent(firstUserMessage.content);
    return text.trim().slice(0, 50) || "New Conversation";
  }

  private extractTextContent(content: string | ContentBlock[]): string {
    if (typeof content === "string") {
      return content;
    }

    return content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");
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

    await this.runMemoryWriteThrough(conversation, session, compactResult.value);

    return ok(compactResult.value.session ?? session);
  }

  private async buildEnvironmentSystemPrompt(personaId?: string): Promise<string | undefined> {
    const provider = this.environmentOptions?.environmentContextProvider;
    const registry = this.environmentOptions?.personaRegistry;

    if (!provider || !registry) {
      return undefined;
    }

    const persona = this.resolvePersonaForPrompt(personaId);
    if (!persona) {
      return undefined;
    }

    const promptResult = await provider.buildEnvironmentPrompt(persona);
    if (!promptResult.ok) {
      return persona.systemPrompt;
    }

    return promptResult.value;
  }

  private async syncEnvironmentSystemPrompt(conversation: Conversation): Promise<void> {
    const nextPrompt = await this.buildEnvironmentSystemPrompt(conversation.personaId);
    if (typeof nextPrompt !== "string") {
      return;
    }

    const latestSystemMessage = [...conversation.messages]
      .reverse()
      .find((message) => message.role === "system");

    if (latestSystemMessage?.content === nextPrompt) {
      return;
    }

    await this.addMessage(conversation.id, {
      role: "system",
      content: nextPrompt,
    });
  }

  private resolvePersonaForPrompt(personaId?: string) {
    const registry = this.environmentOptions?.personaRegistry;
    if (!registry) {
      return undefined;
    }

    if (personaId) {
      return registry.get(personaId);
    }

    return registry.getDefault();
  }

  private async runMemoryWriteThrough(
    conversation: Conversation,
    session: SessionMetadata,
    compactionResult: { compacted: boolean; compactedMessages?: number },
  ): Promise<void> {
    const writeThrough = this.compactionOptions?.memoryWriteThrough;
    if (!writeThrough || !compactionResult.compacted) {
      return;
    }

    const logger = writeThrough.logger ?? noopCompactionLogger;
    const truncationPoint = compactionResult.compactedMessages ?? 0;
    if (truncationPoint === 0) {
      return;
    }

    const context: CompactionContext = {
      conversationId: conversation.id,
      sessionId: session.id,
      compactionReason: "token-threshold",
      timestamp: new Date(),
      truncationPoint,
    };

    const messagesToPreserve = conversation.messages.slice(0, truncationPoint);

    logger.info(
      `Memory write-through: extracting facts from ${messagesToPreserve.length} compacted messages`,
    );

    const result = await writeThrough.compactionManager.compact(messagesToPreserve, context);
    if (!result.ok) {
      logger.warn(
        `Memory write-through failed: ${result.error.message}`,
      );
      return;
    }

    const { telemetry } = result.value;
    logger.info(
      `Memory write-through complete: extracted=${telemetry.extractedCount} persisted=${telemetry.persistedCount} duplicates=${telemetry.skippedDuplicates}`,
    );
  }
}

const noopCompactionLogger: CompactionMemoryLogger = {
  info() {},
  warn() {},
  error() {},
};
