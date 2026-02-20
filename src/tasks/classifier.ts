/**
 * Heuristic background task classifier.
 *
 * Detects whether a user message should be offered as a background task
 * using keyword matching. No LLM calls — pure string matching only.
 *
 * The classifier recognizes two categories:
 * 1. **Explicit command** — `/task <description>` always creates a task.
 * 2. **Async phrases** — keywords like "in the background" or "while I'm away"
 *    suggest the user wants work done asynchronously.
 */

export interface TaskClassification {
  /** Whether the system should offer to run this as a background task. */
  shouldOffer: boolean;
  /** Confidence score from 0 to 1. Higher = stronger signal. */
  confidence: number;
  /** Human-readable reason explaining the classification. */
  reason: string;
}

/**
 * Keyword entry with associated confidence weight.
 *
 * Higher confidence keywords are more explicit signals that the user
 * wants background execution. Lower confidence keywords are suggestive
 * but may appear in normal conversation.
 */
interface KeywordEntry {
  readonly phrase: string;
  readonly confidence: number;
}

/**
 * Background task keywords ordered by confidence (highest first).
 *
 * Phrases are matched case-insensitively against the full message text.
 * Multi-word phrases are preferred over single words to reduce false positives.
 */
const BACKGROUND_KEYWORDS: ReadonlyArray<KeywordEntry> = [
  // High confidence — explicit async intent
  { phrase: "in the background", confidence: 0.95 },
  { phrase: "as a background task", confidence: 0.95 },
  { phrase: "run in background", confidence: 0.95 },
  { phrase: "while i'm away", confidence: 0.9 },
  { phrase: "while im away", confidence: 0.9 },
  { phrase: "while i am away", confidence: 0.9 },
  { phrase: "when you get a chance", confidence: 0.85 },
  { phrase: "when you have a chance", confidence: 0.85 },
  { phrase: "when you get time", confidence: 0.85 },
  { phrase: "when you have time", confidence: 0.85 },
  { phrase: "no rush", confidence: 0.8 },
  { phrase: "no hurry", confidence: 0.8 },
  { phrase: "take your time", confidence: 0.8 },

  // Medium confidence — deferred intent
  { phrase: "in your spare time", confidence: 0.75 },
  { phrase: "at your convenience", confidence: 0.75 },
  { phrase: "whenever you can", confidence: 0.7 },
  { phrase: "sometime today", confidence: 0.7 },
  { phrase: "sometime later", confidence: 0.7 },

  // Lower confidence — suggestive but ambiguous
  { phrase: "eventually", confidence: 0.6 },
  { phrase: "sometime", confidence: 0.55 },
  { phrase: "later", confidence: 0.5 },
];

/** Pattern for the explicit `/task` command. */
const TASK_COMMAND_PATTERN = /^\/task\s+/;

/**
 * Classifies whether a user message should be offered as a background task.
 *
 * Detection uses two mechanisms:
 * 1. The `/task <description>` command always triggers with confidence 1.0.
 * 2. Keyword matching against known async phrases, returning the highest
 *    confidence match found.
 *
 * @param message - The raw user message to classify.
 * @returns Classification result with offer decision, confidence, and reason.
 *
 * @example
 * ```ts
 * classifyAsBackgroundTask("/task research quantum computing");
 * // { shouldOffer: true, confidence: 1.0, reason: "Explicit /task command" }
 *
 * classifyAsBackgroundTask("Can you do this in the background?");
 * // { shouldOffer: true, confidence: 0.95, reason: 'Matched keyword: "in the background"' }
 *
 * classifyAsBackgroundTask("What's the weather today?");
 * // { shouldOffer: false, confidence: 0, reason: "No background task indicators found" }
 * ```
 */
export function classifyAsBackgroundTask(message: string): TaskClassification {
  const trimmed = message.trim();

  if (trimmed.length === 0) {
    return {
      shouldOffer: false,
      confidence: 0,
      reason: "Empty message",
    };
  }

  // Check for explicit /task command first
  if (TASK_COMMAND_PATTERN.test(trimmed)) {
    return {
      shouldOffer: true,
      confidence: 1.0,
      reason: "Explicit /task command",
    };
  }

  // Case-insensitive keyword matching — return highest confidence match
  const lowered = trimmed.toLowerCase();

  for (const entry of BACKGROUND_KEYWORDS) {
    if (lowered.includes(entry.phrase)) {
      return {
        shouldOffer: true,
        confidence: entry.confidence,
        reason: `Matched keyword: "${entry.phrase}"`,
      };
    }
  }

  return {
    shouldOffer: false,
    confidence: 0,
    reason: "No background task indicators found",
  };
}

/**
 * Extracts the task description from a `/task` command message.
 *
 * @param message - The raw user message starting with `/task`.
 * @returns The task description, or null if the message is not a `/task` command.
 *
 * @example
 * ```ts
 * extractTaskDescription("/task research quantum computing");
 * // "research quantum computing"
 *
 * extractTaskDescription("hello world");
 * // null
 * ```
 */
export function extractTaskDescription(message: string): string | null {
  const trimmed = message.trim();

  if (!TASK_COMMAND_PATTERN.test(trimmed)) {
    return null;
  }

  const description = trimmed.replace(TASK_COMMAND_PATTERN, "").trim();
  return description.length > 0 ? description : null;
}
