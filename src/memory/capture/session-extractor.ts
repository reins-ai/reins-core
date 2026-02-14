import { ReinsError } from "../../errors";
import { err, ok, type Result } from "../../result";
import { getTextContent, type Message, type MessageRole } from "../../types";
import type { ImplicitMemoryInput } from "../services/memory-service";
import type { MemoryRecord, MemoryType } from "../types/index";
import {
  DEFAULT_EXTRACTION_CONFIG,
  type ExtractedItem,
  type ExtractionCategory,
  type ExtractionConfig,
  type ExtractionResult,
} from "./extraction-schema";

const DEFAULT_EXTRACTION_VERSION = "session-extractor-v1";

const CATEGORY_RULES: Record<ExtractionCategory, Array<{ regex: RegExp; baseConfidence: number; tags: string[] }>> = {
  decision: [
    { regex: /\bi(?:'ll| will) go with\b/i, baseConfidence: 0.9, tags: ["intentional_choice"] },
    { regex: /\blet(?:'s| us) use\b/i, baseConfidence: 0.85, tags: ["implementation_choice"] },
    { regex: /\bdecided to\b/i, baseConfidence: 0.9, tags: ["finalized"] },
    { regex: /\bchoosing\b/i, baseConfidence: 0.7, tags: ["selection"] },
  ],
  fact: [
    { regex: /\bmy name is\b/i, baseConfidence: 0.95, tags: ["identity"] },
    { regex: /\bi work at\b/i, baseConfidence: 0.9, tags: ["employment"] },
    { regex: /\bi use\b/i, baseConfidence: 0.7, tags: ["tooling"] },
    { regex: /\bi have\b/i, baseConfidence: 0.65, tags: ["user_state"] },
  ],
  preference: [
    { regex: /\bi prefer\b/i, baseConfidence: 0.95, tags: ["explicit_preference"] },
    { regex: /\bi like\b/i, baseConfidence: 0.75, tags: ["stated_preference"] },
    { regex: /\bi want\b/i, baseConfidence: 0.65, tags: ["desired_outcome"] },
    { regex: /\bi always\b/i, baseConfidence: 0.8, tags: ["habitual_behavior"] },
  ],
  action_item: [
    { regex: /\bTODO\b/i, baseConfidence: 0.95, tags: ["task"] },
    { regex: /\bi need to\b/i, baseConfidence: 0.85, tags: ["task"] },
    { regex: /\bremind me to\b/i, baseConfidence: 0.9, tags: ["reminder"] },
    { regex: /\bdon't forget\b/i, baseConfidence: 0.9, tags: ["reminder"] },
  ],
  observation: [
    { regex: /\bit seems\b/i, baseConfidence: 0.5, tags: ["inference"] },
    { regex: /\bi noticed\b/i, baseConfidence: 0.7, tags: ["observation"] },
    { regex: /\bit looks like\b/i, baseConfidence: 0.5, tags: ["inference"] },
  ],
};

export interface SessionContext {
  sessionId: string;
  conversationId: string;
  timestamp?: Date;
}

export interface SessionExtractorMemoryService {
  saveImplicit(input: ImplicitMemoryInput): Promise<Result<MemoryRecord>>;
}

export interface SessionExtractorOptions {
  memoryService: SessionExtractorMemoryService;
  config?: Partial<ExtractionConfig>;
  extractionVersion?: string;
  now?: () => Date;
}

export class SessionExtractionError extends ReinsError {
  constructor(message: string, code: string, cause?: Error) {
    super(message, code, cause);
    this.name = "SessionExtractionError";
  }
}

export class SessionExtractor {
  private readonly memoryService: SessionExtractorMemoryService;
  private readonly config: ExtractionConfig;
  private readonly extractionVersion: string;
  private readonly now: () => Date;

  constructor(options: SessionExtractorOptions) {
    this.memoryService = options.memoryService;
    this.config = {
      confidenceThreshold:
        options.config?.confidenceThreshold ?? DEFAULT_EXTRACTION_CONFIG.confidenceThreshold,
      maxItemsPerSession: options.config?.maxItemsPerSession ?? DEFAULT_EXTRACTION_CONFIG.maxItemsPerSession,
      enabledCategories: options.config?.enabledCategories ?? DEFAULT_EXTRACTION_CONFIG.enabledCategories,
    };
    this.extractionVersion = options.extractionVersion ?? DEFAULT_EXTRACTION_VERSION;
    this.now = options.now ?? (() => new Date());
  }

  async extractFromSession(
    messages: Message[],
    sessionContext: SessionContext,
  ): Promise<Result<ExtractionResult, SessionExtractionError>> {
    if (!sessionContext.sessionId.trim()) {
      return err(
        new SessionExtractionError(
          "Session context must include a non-empty sessionId",
          "SESSION_EXTRACTOR_INVALID_CONTEXT",
        ),
      );
    }

    if (!sessionContext.conversationId.trim()) {
      return err(
        new SessionExtractionError(
          "Session context must include a non-empty conversationId",
          "SESSION_EXTRACTOR_INVALID_CONTEXT",
        ),
      );
    }

    const extractedItems = new Map<string, ExtractedItem>();

    for (const message of messages) {
      const text = getTextContent(message.content).trim();
      if (!text) {
        continue;
      }

      const candidates = this.extractFromMessage(text, message.id, message.role);
      for (const candidate of candidates) {
        const key = `${candidate.category}:${normalizeForKey(candidate.content)}`;
        const existing = extractedItems.get(key);
        if (!existing) {
          extractedItems.set(key, candidate);
          continue;
        }

        extractedItems.set(key, {
          category: existing.category,
          content: existing.content,
          confidence: Math.max(existing.confidence, candidate.confidence),
          tags: unique([...existing.tags, ...candidate.tags]),
          entities: unique([...existing.entities, ...candidate.entities]),
          sourceMessageIds: unique([...existing.sourceMessageIds, ...candidate.sourceMessageIds]),
        });
      }
    }

    const items = [...extractedItems.values()]
      .filter((item) => item.confidence >= this.config.confidenceThreshold)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, this.config.maxItemsPerSession);

    return ok({
      sessionId: sessionContext.sessionId,
      conversationId: sessionContext.conversationId,
      timestamp: sessionContext.timestamp ?? this.now(),
      items,
      extractionVersion: this.extractionVersion,
    });
  }

  async persistExtractions(
    result: ExtractionResult,
  ): Promise<Result<string[], SessionExtractionError>> {
    const persistedIds: string[] = [];
    const extractedAt = result.timestamp.toISOString();

    for (const item of result.items) {
      const input: ImplicitMemoryInput = {
        content: toPersistedContent(item),
        type: mapCategoryToMemoryType(item.category),
        confidence: item.confidence,
        tags: unique([
          ...item.tags,
          `category:${item.category}`,
          `session:${result.sessionId}`,
          `extracted-at:${extractedAt}`,
          `extraction-version:${result.extractionVersion}`,
        ]),
        entities: unique([
          ...item.entities,
          ...item.sourceMessageIds.map((messageId) => `message:${messageId}`),
          `conversation:${result.conversationId}`,
        ]),
        conversationId: result.conversationId,
        messageId: item.sourceMessageIds[0],
      };

      const persistResult = await this.memoryService.saveImplicit(input);
      if (!persistResult.ok) {
        return err(
          new SessionExtractionError(
            `Failed to persist extracted item (${item.category})`,
            "SESSION_EXTRACTOR_PERSIST_FAILED",
            persistResult.error,
          ),
        );
      }

      persistedIds.push(persistResult.value.id);
    }

    return ok(persistedIds);
  }

  private extractFromMessage(
    text: string,
    messageId: string,
    role: MessageRole,
  ): ExtractedItem[] {
    const items: ExtractedItem[] = [];

    for (const category of this.config.enabledCategories) {
      const ruleSet = CATEGORY_RULES[category];
      for (const rule of ruleSet) {
        if (!rule.regex.test(text)) {
          continue;
        }

        const confidence = clampConfidence(
          rule.baseConfidence + roleConfidenceBoost(role),
        );
        const content = text.replace(/\s+/g, " ").trim();
        const tags = unique([
          ...rule.tags,
          ...extractKeywordTags(text),
          `role:${role}`,
        ]);

        items.push({
          category,
          content,
          confidence,
          tags,
          entities: extractEntities(text),
          sourceMessageIds: [messageId],
        });
      }
    }

    return items;
  }
}

function roleConfidenceBoost(role: MessageRole): number {
  if (role === "user") {
    return 0.08;
  }

  if (role === "assistant") {
    return -0.03;
  }

  return -0.05;
}

function mapCategoryToMemoryType(category: ExtractionCategory): MemoryType {
  switch (category) {
    case "decision":
      return "decision";
    case "preference":
      return "preference";
    case "fact":
      return "fact";
    case "action_item":
    case "observation":
      return "fact";
  }
}

function toPersistedContent(item: ExtractedItem): string {
  if (item.category === "action_item") {
    return `Action item: ${item.content}`;
  }

  if (item.category === "observation") {
    return `Observation: ${item.content}`;
  }

  return item.content;
}

function normalizeForKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function clampConfidence(value: number): number {
  if (value < 0) {
    return 0;
  }

  if (value > 1) {
    return 1;
  }

  return Math.round(value * 1000) / 1000;
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractEntities(text: string): string[] {
  const candidates = text.match(/\b[A-Z][a-zA-Z0-9_-]{1,}\b/g) ?? [];
  return unique(candidates);
}

function extractKeywordTags(text: string): string[] {
  const normalized = text.toLowerCase();
  const tags: string[] = [];

  if (normalized.includes("typescript")) {
    tags.push("typescript");
  }

  if (normalized.includes("bun")) {
    tags.push("bun");
  }

  if (normalized.includes("react")) {
    tags.push("react");
  }

  if (normalized.includes("openai")) {
    tags.push("openai");
  }

  return tags;
}
