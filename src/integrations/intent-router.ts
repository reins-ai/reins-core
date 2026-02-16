import type { IntegrationOperation } from "./types";
import type { IntegrationRegistry } from "./registry";

/**
 * A detected intent mapping a user message to a specific integration.
 */
export interface DetectedIntent {
  integrationId: string;
  confidence: number;
  matchedKeywords: string[];
}

/**
 * Tool schemas injected as a fallback when progressive disclosure is bypassed.
 */
export interface FallbackInjection {
  integrationId: string;
  operations: IntegrationOperation[];
}

/**
 * A keyword rule mapping phrases to an integration.
 */
interface IntentKeywordRule {
  integrationId: string;
  /** Single words that contribute to intent scoring. */
  keywords: string[];
  /** Multi-word phrases that contribute higher confidence. */
  phrases: string[];
}

const DEFAULT_INTENT_RULES: IntentKeywordRule[] = [
  {
    integrationId: "obsidian",
    keywords: [
      "obsidian",
      "vault",
      "note",
      "notes",
      "markdown",
    ],
    phrases: [
      "search notes",
      "search my notes",
      "find notes",
      "find a note",
      "read note",
      "read a note",
      "open note",
      "create note",
      "create a note",
      "new note",
      "write a note",
      "list notes",
      "my notes",
      "in my vault",
      "in obsidian",
      "obsidian vault",
      "note about",
      "notes about",
    ],
  },
];

/** Weight for a single keyword match. */
const KEYWORD_WEIGHT = 0.2;

/** Weight for a phrase match. */
const PHRASE_WEIGHT = 0.4;

/** Maximum confidence score (capped). */
const MAX_CONFIDENCE = 1.0;

/** Minimum confidence threshold for a valid detection. */
const MIN_CONFIDENCE_THRESHOLD = 0.2;

/**
 * Routes user intent to integrations by matching keywords and phrases.
 *
 * Used as a fallback when the LLM doesn't follow the progressive disclosure
 * flow (discover → activate → execute). When integration-related intent is
 * detected in a user message, the router provides the relevant tool schemas
 * so the LLM can use them directly.
 */
export class IntentRouter {
  private readonly rules: IntentKeywordRule[];

  constructor(
    private readonly registry: IntegrationRegistry,
    rules?: IntentKeywordRule[],
  ) {
    this.rules = rules ?? DEFAULT_INTENT_RULES;
  }

  /**
   * Detect integration intent from a user message.
   *
   * Returns detected intents sorted by confidence (highest first).
   * Only intents above the minimum confidence threshold are returned.
   * Only intents for integrations that are registered and active are returned.
   */
  detectIntent(message: string): DetectedIntent[] {
    const normalized = message.toLowerCase();
    const detections: DetectedIntent[] = [];

    for (const rule of this.rules) {
      if (!this.isIntegrationActive(rule.integrationId)) {
        continue;
      }

      const matchedKeywords: string[] = [];
      let score = 0;

      for (const phrase of rule.phrases) {
        if (normalized.includes(phrase)) {
          matchedKeywords.push(phrase);
          score += PHRASE_WEIGHT;
        }
      }

      for (const keyword of rule.keywords) {
        if (this.containsWord(normalized, keyword)) {
          matchedKeywords.push(keyword);
          score += KEYWORD_WEIGHT;
        }
      }

      if (score >= MIN_CONFIDENCE_THRESHOLD && matchedKeywords.length > 0) {
        detections.push({
          integrationId: rule.integrationId,
          confidence: Math.min(score, MAX_CONFIDENCE),
          matchedKeywords,
        });
      }
    }

    return detections.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * Get tool schemas for detected intents, suitable for direct injection
   * into the LLM context when progressive disclosure is bypassed.
   *
   * Returns fallback injections for all detected intents above threshold.
   */
  getToolSchemas(message: string): FallbackInjection[] {
    const intents = this.detectIntent(message);
    const injections: FallbackInjection[] = [];

    for (const intent of intents) {
      const integration = this.registry.get(intent.integrationId);
      if (!integration) {
        continue;
      }

      injections.push({
        integrationId: intent.integrationId,
        operations: integration.getOperations(),
      });
    }

    return injections;
  }

  /**
   * Check whether a word appears as a standalone token in the text.
   * Prevents partial matches (e.g., "note" inside "notebook" is still
   * matched because users commonly say "note" to mean notes).
   *
   * Uses word-boundary detection via surrounding non-alphanumeric characters.
   */
  private containsWord(text: string, word: string): boolean {
    const index = text.indexOf(word);
    if (index === -1) {
      return false;
    }

    const before = index === 0 || !this.isAlphanumeric(text[index - 1]);
    const after =
      index + word.length >= text.length ||
      !this.isAlphanumeric(text[index + word.length]);

    return before && after;
  }

  private isAlphanumeric(char: string): boolean {
    const code = char.charCodeAt(0);
    return (
      (code >= 48 && code <= 57) ||
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122)
    );
  }

  private isIntegrationActive(integrationId: string): boolean {
    const integration = this.registry.get(integrationId);
    if (!integration) {
      return false;
    }

    return integration.config.enabled;
  }
}
