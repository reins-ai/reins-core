import { ReinsError } from "../../errors";
import { ok, type Result } from "../../result";
import type { MemoryType } from "../types/memory-types";
import type { MemoryRecord } from "../types/memory-record";
import type { NudgeFeedbackStore } from "./nudge-feedback-store";

export type NudgeType = "reminder" | "suggestion" | "context";

export interface NudgeConfig {
  enabled: boolean;
  maxNudgesPerTurn: number;
  minRelevanceScore: number;
  cooldownMs: number;
  nudgeTypes: MemoryType[];
  dismissedTopicWindowMs: number;
}

export interface Nudge {
  id: string;
  content: string;
  memorySource: MemoryRecord;
  relevanceScore: number;
  reason: string;
  type: NudgeType;
  dismissible: boolean;
}

export interface NudgeDecision {
  shouldNudge: boolean;
  nudges: Nudge[];
  reasoning: string;
}

export interface ConversationContext {
  query: string;
  conversationId: string;
  recentTopics: string[];
}

export interface NudgeRetrievalResult {
  id: string;
  content: string;
  score: number;
  record: MemoryRecord;
}

export interface NudgeMemoryRetrieval {
  search(
    query: string,
    options: {
      topK: number;
      types?: MemoryType[];
    },
  ): Promise<Result<NudgeRetrievalResult[]>>;
}

export interface NudgeEngineOptions {
  retrieval: NudgeMemoryRetrieval;
  feedbackStore: NudgeFeedbackStore;
  config: NudgeConfig;
}

export class NudgeEngineError extends ReinsError {
  constructor(message: string, code = "NUDGE_ENGINE_ERROR", cause?: Error) {
    super(message, code, cause);
    this.name = "NudgeEngineError";
  }
}

const RETRIEVAL_EXPANSION_FACTOR = 3;

function inferNudgeType(record: MemoryRecord): NudgeType {
  switch (record.type) {
    case "preference":
    case "fact":
      return "context";
    case "decision":
    case "episode":
      return "reminder";
    default:
      return "suggestion";
  }
}

function buildReason(record: MemoryRecord, score: number): string {
  const typeLabel = record.type;
  const scoreLabel = (score * 100).toFixed(0);
  return `Relevant ${typeLabel} memory (${scoreLabel}% match) from ${record.provenance.sourceType} source`;
}

function generateNudgeId(memoryId: string, conversationId: string): string {
  return `nudge_${memoryId}_${conversationId}`;
}

function isTopicMatch(record: MemoryRecord, dismissedTopics: string[]): boolean {
  if (dismissedTopics.length === 0) {
    return false;
  }

  const contentLower = record.content.toLowerCase();
  const tagsLower = record.tags.map((tag) => tag.toLowerCase());

  for (const topic of dismissedTopics) {
    const topicLower = topic.toLowerCase();
    if (contentLower.includes(topicLower)) {
      return true;
    }

    for (const tag of tagsLower) {
      if (tag === topicLower || tag.includes(topicLower)) {
        return true;
      }
    }
  }

  return false;
}

export class NudgeEngine {
  private readonly retrieval: NudgeMemoryRetrieval;
  private readonly feedbackStore: NudgeFeedbackStore;
  private readonly config: NudgeConfig;
  private readonly recentNudgeTimestamps: Map<string, number> = new Map();

  constructor(options: NudgeEngineOptions) {
    this.retrieval = options.retrieval;
    this.feedbackStore = options.feedbackStore;
    this.config = options.config;
  }

  async evaluate(
    context: ConversationContext,
  ): Promise<Result<NudgeDecision, NudgeEngineError>> {
    if (!this.config.enabled) {
      return ok({
        shouldNudge: false,
        nudges: [],
        reasoning: "Nudge engine is disabled",
      });
    }

    const query = context.query.trim();
    if (query.length === 0) {
      return ok({
        shouldNudge: false,
        nudges: [],
        reasoning: "No query content to evaluate",
      });
    }

    const retrievalTopK = this.config.maxNudgesPerTurn * RETRIEVAL_EXPANSION_FACTOR;
    const searchResult = await this.retrieval.search(query, {
      topK: retrievalTopK,
      types: this.config.nudgeTypes.length > 0 ? this.config.nudgeTypes : undefined,
    });

    if (!searchResult.ok) {
      return ok({
        shouldNudge: false,
        nudges: [],
        reasoning: "Memory retrieval unavailable; returning no nudges",
      });
    }

    const candidates = searchResult.value;
    if (candidates.length === 0) {
      return ok({
        shouldNudge: false,
        nudges: [],
        reasoning: "No relevant memories found",
      });
    }

    const dismissedTopics = this.feedbackStore.getDismissedTopics(
      this.config.dismissedTopicWindowMs,
    );

    const now = Date.now();
    const nudges: Nudge[] = [];
    const rejectionReasons: string[] = [];

    for (const candidate of candidates) {
      if (nudges.length >= this.config.maxNudgesPerTurn) {
        break;
      }

      if (candidate.score < this.config.minRelevanceScore) {
        rejectionReasons.push(
          `Memory ${candidate.id}: below relevance threshold (${candidate.score.toFixed(2)} < ${this.config.minRelevanceScore})`,
        );
        continue;
      }

      const lastNudgeTime = this.recentNudgeTimestamps.get(candidate.id);
      if (lastNudgeTime !== undefined && now - lastNudgeTime < this.config.cooldownMs) {
        rejectionReasons.push(
          `Memory ${candidate.id}: within cooldown period`,
        );
        continue;
      }

      if (isTopicMatch(candidate.record, dismissedTopics)) {
        rejectionReasons.push(
          `Memory ${candidate.id}: topic previously dismissed`,
        );
        continue;
      }

      const nudgeId = generateNudgeId(candidate.id, context.conversationId);
      nudges.push({
        id: nudgeId,
        content: candidate.content,
        memorySource: candidate.record,
        relevanceScore: candidate.score,
        reason: buildReason(candidate.record, candidate.score),
        type: inferNudgeType(candidate.record),
        dismissible: true,
      });

      this.recentNudgeTimestamps.set(candidate.id, now);
    }

    const shouldNudge = nudges.length > 0;
    const reasoningParts: string[] = [];

    if (shouldNudge) {
      reasoningParts.push(
        `Selected ${nudges.length} nudge(s) from ${candidates.length} candidate(s)`,
      );
    } else {
      reasoningParts.push("No nudges passed policy filters");
    }

    if (rejectionReasons.length > 0) {
      reasoningParts.push(`Filtered: ${rejectionReasons.join("; ")}`);
    }

    return ok({
      shouldNudge,
      nudges,
      reasoning: reasoningParts.join(". "),
    });
  }
}
