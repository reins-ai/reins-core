import { estimateConversationTokens, estimateTokens } from "../context/tokenizer";
import { ConversationError } from "../errors";
import type { MemoryEntry, MemoryStore } from "../memory";
import { ok, type Result } from "../result";
import type { Conversation, Message } from "../types";
import type { SessionMetadata, SessionRepository } from "./session-repository";
import type { ConversationStore } from "./store";
import { TranscriptStore } from "./transcript-store";

const DEFAULT_CONTEXT_WINDOW_TOKENS = 16_000;
const DEFAULT_TOKEN_THRESHOLD_RATIO = 0.8;
const DEFAULT_KEEP_RECENT_MESSAGES = 10;
const DEFAULT_SUMMARY_MAX_TOKENS = 400;

export interface CompactionConfig {
  tokenThreshold: number;
  keepRecentMessages: number;
  summaryMaxTokens: number;
  contextWindowTokens?: number;
}

export interface CompactionResult {
  compacted: boolean;
  summary?: string;
  compactedMessages?: number;
  flushedMemories?: number;
  conversation?: Conversation;
  session?: SessionMetadata;
}

export type SummaryGenerator = (
  messages: Message[],
  config: CompactionConfig,
) => Promise<Result<string, ConversationError>>;

interface PersistNowCapableMemoryStore {
  persistNow?: () => Promise<Result<void, ConversationError>>;
  flush?: () => Promise<Result<void, ConversationError>>;
}

export class CompactionService {
  private readonly config: CompactionConfig;
  private readonly summarizer: SummaryGenerator;

  constructor(options: { config?: Partial<CompactionConfig>; summarizer?: SummaryGenerator } = {}) {
    const contextWindowTokens =
      options.config?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;
    const tokenThreshold = options.config?.tokenThreshold ?? DEFAULT_TOKEN_THRESHOLD_RATIO;

    this.config = {
      tokenThreshold,
      keepRecentMessages: options.config?.keepRecentMessages ?? DEFAULT_KEEP_RECENT_MESSAGES,
      summaryMaxTokens: options.config?.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS,
      contextWindowTokens,
    };

    this.summarizer = options.summarizer ?? this.generateSummary.bind(this);
  }

  shouldCompact(session: SessionMetadata, conversation: Conversation): Result<boolean, ConversationError> {
    if (session.status === "compacting") {
      return ok(false);
    }

    const threshold = this.getCompactionThreshold();
    const totalTokens = estimateConversationTokens(conversation.messages);
    return ok(totalTokens >= threshold);
  }

  async compact(
    session: SessionMetadata,
    conversation: Conversation,
    memoryStore: MemoryStore,
    transcriptStore: TranscriptStore,
    sessionRepository: SessionRepository,
    conversationStore: ConversationStore,
  ): Promise<Result<CompactionResult, ConversationError>> {
    if (session.status === "compacting") {
      return ok({ compacted: false, conversation, session });
    }

    const shouldCompactResult = this.shouldCompact(session, conversation);
    if (!shouldCompactResult.ok) {
      return shouldCompactResult;
    }

    if (!shouldCompactResult.value) {
      return ok({ compacted: false, conversation, session });
    }

    const keepCount = Math.max(0, this.config.keepRecentMessages);
    const compactedMessages = Math.max(0, conversation.messages.length - keepCount);
    if (compactedMessages === 0) {
      return ok({ compacted: false, conversation, session });
    }

    const messagesToCompact = conversation.messages.slice(0, compactedMessages);
    const messagesToKeep = conversation.messages.slice(compactedMessages);

    const beginStatusResult = await sessionRepository.update(session.id, {
      status: "compacting",
    });
    if (!beginStatusResult.ok) {
      return beginStatusResult;
    }

    let sessionResult: SessionMetadata = beginStatusResult.value;

    try {
      const extractedMemories = this.extractMemories(messagesToCompact, conversation.id);
      for (const memory of extractedMemories) {
        await memoryStore.save(memory);
      }

      const flushResult = await this.persistMemory(memoryStore);
      if (!flushResult.ok) {
        return flushResult;
      }

      const flushEntryResult = await transcriptStore.append(session.id, {
        type: "memory_flush",
        timestamp: new Date().toISOString(),
        memoriesCount: extractedMemories.length,
      });
      if (!flushEntryResult.ok) {
        return flushEntryResult;
      }

      const summaryResult = await this.summarizer(messagesToCompact, this.config);
      if (!summaryResult.ok) {
        return summaryResult;
      }

      const compactionEntryResult = await transcriptStore.append(session.id, {
        type: "compaction",
        timestamp: new Date().toISOString(),
        summary: summaryResult.value,
        messagesCompacted: compactedMessages,
      });
      if (!compactionEntryResult.ok) {
        return compactionEntryResult;
      }

      const transcriptSyncResult = await transcriptStore.sync(session.id);
      if (!transcriptSyncResult.ok) {
        return transcriptSyncResult;
      }

      const summaryMessage: Message = {
        id: `summary_${crypto.randomUUID()}`,
        role: "system",
        content: `Conversation summary:\n${summaryResult.value}`,
        createdAt: new Date(),
      };

      const compactedConversation: Conversation = {
        ...conversation,
        messages: [summaryMessage, ...messagesToKeep],
        updatedAt: new Date(),
      };

      await conversationStore.save(compactedConversation);

      const finalizedSessionResult = await sessionRepository.update(session.id, {
        status: "active",
        lastCompactedAt: new Date().toISOString(),
        messageCount: compactedConversation.messages.length,
        tokenCount: estimateConversationTokens(compactedConversation.messages),
      });
      if (!finalizedSessionResult.ok) {
        return finalizedSessionResult;
      }

      sessionResult = finalizedSessionResult.value;

      return ok({
        compacted: true,
        summary: summaryResult.value,
        compactedMessages,
        flushedMemories: extractedMemories.length,
        conversation: compactedConversation,
        session: sessionResult,
      });
    } finally {
      if (sessionResult.status === "compacting") {
        await sessionRepository.update(session.id, { status: "active" });
      }
    }
  }

  extractMemories(
    messages: Message[],
    conversationId?: string,
  ): Array<Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">> {
    const maxMemories = 10;
    const memories: Array<Omit<MemoryEntry, "id" | "createdAt" | "updatedAt">> = [];

    for (const message of messages) {
      if ((message.role !== "user" && message.role !== "assistant") || !message.content.trim()) {
        continue;
      }

      const content = message.content.trim();
      const normalized = content.toLowerCase();
      const isPreference = /\b(prefer|likes?|favorite|always|never)\b/u.test(normalized);
      const isFact = /\b(decide|decision|must|should|will|important|remember)\b/u.test(normalized);

      if (!isPreference && !isFact) {
        continue;
      }

      memories.push({
        content,
        type: isPreference ? "preference" : "fact",
        tags: ["compaction", "flush", message.role],
        importance: isPreference ? 0.9 : 0.7,
        conversationId,
      });

      if (memories.length >= maxMemories) {
        break;
      }
    }

    return memories;
  }

  async generateSummary(
    messages: Message[],
    config: CompactionConfig = this.config,
  ): Promise<Result<string, ConversationError>> {
    if (messages.length === 0) {
      return ok("No messages were compacted.");
    }

    const lines: string[] = [];
    for (const message of messages) {
      const role = message.role.toUpperCase();
      const normalized = message.content.replace(/\s+/gu, " ").trim();
      if (!normalized) {
        continue;
      }

      const line = `- ${role}: ${normalized}`;
      const candidate = [...lines, line].join("\n");
      if (estimateTokens(candidate) > config.summaryMaxTokens) {
        break;
      }

      lines.push(line);
    }

    if (lines.length === 0) {
      return ok("No compactable message content available.");
    }

    return ok(lines.join("\n"));
  }

  getCompactionThreshold(): number {
    const ratio = this.config.tokenThreshold;
    const contextWindow = this.config.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS;

    return Number.isFinite(ratio)
      ? Math.max(1, Math.floor(contextWindow * ratio))
      : Math.max(1, Math.floor(contextWindow * DEFAULT_TOKEN_THRESHOLD_RATIO));
  }

  private async persistMemory(memoryStore: MemoryStore): Promise<Result<void, ConversationError>> {
    const maybeFlushable = memoryStore as MemoryStore & PersistNowCapableMemoryStore;

    if (typeof maybeFlushable.persistNow === "function") {
      return maybeFlushable.persistNow();
    }

    if (typeof maybeFlushable.flush === "function") {
      return maybeFlushable.flush();
    }

    return ok(undefined);
  }
}
