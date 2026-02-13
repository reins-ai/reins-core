import { ok, type Result } from "../../result";
import type {
  MemoryPrimingContract,
  MemoryPrimingItem,
  TurnContextParams,
} from "../memory-priming-contract";
import {
  ContextPacker,
  type ContextPackerConfig,
} from "../context/context-packer";

const DEFAULT_TOPIC_WEIGHT = 1;
const MAX_TOPIC_WEIGHT = 3;
const RETRIEVAL_EXPANSION_FACTOR = 3;

export interface PrimingConfig {
  enabled: boolean;
  maxTokens: number;
  maxMemories: number;
  minRelevanceScore: number;
  topicWeight: number;
}

export interface PrimingResult {
  context: string;
  memoriesUsed: number;
  tokensUsed: number;
  memoriesSkipped: number;
  latencyMs: number;
}

export interface ConversationPrimingContext {
  recentMessages: string[];
  currentTopic?: string;
  sessionId: string;
}

export interface PrimingLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface MemoryPrimingMiddlewareOptions {
  retrievalService: MemoryPrimingContract;
  config: PrimingConfig;
  contextPacker?: ContextPacker;
  logger?: PrimingLogger;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

function withLatency(result: Omit<PrimingResult, "latencyMs">, startedAt: number): PrimingResult {
  return {
    ...result,
    latencyMs: Math.max(0, Date.now() - startedAt),
  };
}

function buildEmptyResult(startedAt: number): PrimingResult {
  return withLatency(
    {
      context: "",
      memoriesUsed: 0,
      tokensUsed: 0,
      memoriesSkipped: 0,
    },
    startedAt,
  );
}

function sanitizeMessages(messages: string[]): string[] {
  return messages
    .map((message) => message.trim())
    .filter((message) => message.length > 0);
}

function applyTopicWeight(topic: string | undefined, topicWeight: number): string {
  if (!topic) {
    return "";
  }

  const normalized = topic.trim();
  if (normalized.length === 0) {
    return "";
  }

  const safeWeight = Math.max(1, Math.min(MAX_TOPIC_WEIGHT, Math.round(topicWeight || DEFAULT_TOPIC_WEIGHT)));
  return Array.from({ length: safeWeight }, () => normalized).join(" ");
}

function buildQuery(context: ConversationPrimingContext, topicWeight: number): string {
  const recentMessages = sanitizeMessages(context.recentMessages);
  const recentSummary = recentMessages.slice(-5).join("\n");
  const weightedTopic = applyTopicWeight(context.currentTopic, topicWeight);

  return [weightedTopic, recentSummary].filter((part) => part.length > 0).join("\n").trim();
}

function sortByPriority(memories: MemoryPrimingItem[]): MemoryPrimingItem[] {
  return memories.toSorted((left, right) => {
    if (right.relevanceScore !== left.relevanceScore) {
      return right.relevanceScore - left.relevanceScore;
    }

    if (right.importance !== left.importance) {
      return right.importance - left.importance;
    }

    return left.id.localeCompare(right.id);
  });
}

export class MemoryPrimingMiddleware {
  private readonly retrievalService: MemoryPrimingContract;
  private readonly config: PrimingConfig;
  private readonly contextPacker: ContextPacker;
  private readonly logger: PrimingLogger | undefined;

  constructor(options: MemoryPrimingMiddlewareOptions) {
    this.retrievalService = options.retrievalService;
    this.config = options.config;
    this.contextPacker = options.contextPacker ?? new ContextPacker();
    this.logger = options.logger;
  }

  async prime(conversationContext: ConversationPrimingContext): Promise<Result<PrimingResult>> {
    const startedAt = Date.now();

    if (!this.config.enabled) {
      this.logger?.debug("Memory priming skipped: disabled");
      return ok(buildEmptyResult(startedAt));
    }

    const query = buildQuery(conversationContext, this.config.topicWeight);
    if (query.length === 0) {
      this.logger?.debug("Memory priming skipped: no query content", {
        sessionId: conversationContext.sessionId,
      });
      return ok(buildEmptyResult(startedAt));
    }

    const retrievalParams: TurnContextParams = {
      query,
      conversationId: conversationContext.sessionId,
      maxItems: this.config.maxMemories * RETRIEVAL_EXPANSION_FACTOR,
      maxTokenBudget: this.config.maxTokens * RETRIEVAL_EXPANSION_FACTOR,
    };

    const retrievalResult = await this.retrievalService.getContextForTurn(retrievalParams);
    if (!retrievalResult.ok) {
      this.logger?.warn("Memory priming degraded: retrieval unavailable", {
        sessionId: conversationContext.sessionId,
      });
      return ok(buildEmptyResult(startedAt));
    }

    const relevanceThreshold = clamp01(this.config.minRelevanceScore);
    const filtered = retrievalResult.value.memories.filter(
      (memory) => memory.relevanceScore >= relevanceThreshold,
    );
    const prioritized = sortByPriority(filtered).slice(0, this.config.maxMemories);

    const packedConfig: ContextPackerConfig = {
      tokenBudget: this.config.maxTokens,
      format: "brief",
      includeSources: true,
    };
    const packed = this.contextPacker.pack(prioritized, packedConfig);

    const skipped = Math.max(0, retrievalResult.value.memories.length - packed.memoriesIncluded);
    if (packed.memoriesTruncated > 0 || skipped > 0) {
      this.logger?.debug("Memory priming guardrails applied", {
        sessionId: conversationContext.sessionId,
        packedMemories: packed.memoriesIncluded,
        skipped,
        tokenBudget: this.config.maxTokens,
      });
    }

    return ok(
      withLatency(
        {
          context: packed.text,
          memoriesUsed: packed.memoriesIncluded,
          tokensUsed: packed.tokensUsed,
          memoriesSkipped: skipped,
        },
        startedAt,
      ),
    );
  }
}
