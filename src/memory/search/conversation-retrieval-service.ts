import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import type {
  MemoryPrimingContract,
  MemoryPrimingItem,
  PreferenceOptions,
  PrimingContext,
  TurnContextParams,
} from "../../conversation/memory-priming-contract";
import type { HybridMemorySearch, HybridSearchResult } from "./hybrid-memory-search";

const DEFAULT_MAX_TOKEN_BUDGET = 1000;
const DEFAULT_MAX_ITEMS = 5;
const DEFAULT_PREFERENCE_LIMIT = 10;
const DEFAULT_MIN_IMPORTANCE = 0.5;
const CHARS_PER_TOKEN = 4;

export interface ConversationRetrievalServiceOptions {
  search: HybridMemorySearch;
  logger?: Logger;
}

export interface Logger {
  debug(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export class ConversationRetrievalError extends ReinsError {
  constructor(message: string, code = "CONVERSATION_RETRIEVAL_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "ConversationRetrievalError";
  }
}

function estimateTokens(text: string): number {
  if (text.length === 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function formatSource(result: HybridSearchResult): string {
  const parts: string[] = [result.source.type];

  if (result.source.conversationId) {
    parts.push(`conversation:${result.source.conversationId}`);
  }

  return parts.join(", ");
}

function toMemoryPrimingItem(result: HybridSearchResult): MemoryPrimingItem {
  return {
    id: result.memoryId,
    content: result.content,
    type: result.type,
    importance: result.importance,
    relevanceScore: result.score,
    source: formatSource(result),
    tokenEstimate: estimateTokens(result.content),
  };
}

export class ConversationRetrievalService implements MemoryPrimingContract {
  private readonly search: HybridMemorySearch;
  private readonly logger: Logger | undefined;

  constructor(options: ConversationRetrievalServiceOptions) {
    this.search = options.search;
    this.logger = options.logger;
  }

  async getContextForTurn(
    params: TurnContextParams,
  ): Promise<Result<PrimingContext, ConversationRetrievalError>> {
    const query = params.query.trim();
    if (query.length === 0) {
      return ok({
        memories: [],
        totalTokenEstimate: 0,
        truncated: false,
      });
    }

    const maxTokenBudget = params.maxTokenBudget ?? DEFAULT_MAX_TOKEN_BUDGET;
    const maxItems = params.maxItems ?? DEFAULT_MAX_ITEMS;
    const excludeIds = new Set(params.excludeIds ?? []);

    const candidateLimit = Math.max(maxItems * 3, 15);

    this.logger?.debug("Retrieving context for turn", {
      conversationId: params.conversationId,
      queryLength: query.length,
      maxTokenBudget,
      maxItems,
      excludeCount: excludeIds.size,
    });

    const searchResult = await this.search.search(query, {
      limit: candidateLimit,
    });

    if (!searchResult.ok) {
      this.logger?.error("Hybrid search failed during turn context retrieval", {
        error: searchResult.error.message,
      });

      return err(
        new ConversationRetrievalError(
          "Failed to retrieve context for turn: hybrid search failed",
          "CONVERSATION_RETRIEVAL_SEARCH_FAILED",
          searchResult.error,
        ),
      );
    }

    const candidates = searchResult.value.filter(
      (result) => !excludeIds.has(result.memoryId),
    );

    const memories: MemoryPrimingItem[] = [];
    let totalTokenEstimate = 0;
    let truncated = false;

    for (const candidate of candidates) {
      if (memories.length >= maxItems) {
        truncated = true;
        break;
      }

      const item = toMemoryPrimingItem(candidate);

      if (totalTokenEstimate + item.tokenEstimate > maxTokenBudget) {
        truncated = true;
        break;
      }

      memories.push(item);
      totalTokenEstimate += item.tokenEstimate;
    }

    if (!truncated && candidates.length > memories.length) {
      truncated = true;
    }

    this.logger?.debug("Turn context retrieved", {
      conversationId: params.conversationId,
      memoriesReturned: memories.length,
      totalTokenEstimate,
      truncated,
    });

    return ok({
      memories,
      totalTokenEstimate,
      truncated,
    });
  }

  async getUserPreferences(
    options?: PreferenceOptions,
  ): Promise<Result<MemoryPrimingItem[], ConversationRetrievalError>> {
    const limit = options?.limit ?? DEFAULT_PREFERENCE_LIMIT;
    const minImportance = options?.minImportance ?? DEFAULT_MIN_IMPORTANCE;

    this.logger?.debug("Retrieving user preferences", { limit, minImportance });

    const searchResult = await this.search.search("user preferences", {
      limit: limit * 3,
      memoryTypes: ["preference"],
    });

    if (!searchResult.ok) {
      this.logger?.error("Hybrid search failed during preference retrieval", {
        error: searchResult.error.message,
      });

      return err(
        new ConversationRetrievalError(
          "Failed to retrieve user preferences: hybrid search failed",
          "CONVERSATION_RETRIEVAL_SEARCH_FAILED",
          searchResult.error,
        ),
      );
    }

    const filtered = searchResult.value
      .filter((result) => result.importance >= minImportance)
      .sort((a, b) => b.importance - a.importance)
      .slice(0, limit)
      .map(toMemoryPrimingItem);

    this.logger?.debug("User preferences retrieved", {
      count: filtered.length,
    });

    return ok(filtered);
  }
}
