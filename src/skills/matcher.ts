import type { Skill } from "./types";

/**
 * Identifies which aspect of a skill caused a match.
 */
export type MatchSource = "name" | "trigger" | "description" | "category";

/**
 * A single skill match result with confidence score and match provenance.
 */
export interface SkillMatch {
  /** The matched skill */
  skill: Skill;
  /** Confidence score from 0.0 to 1.0 */
  score: number;
  /** Which metadata fields contributed to the match */
  matchedOn: MatchSource[];
}

/**
 * Configuration for the skill matcher.
 */
export interface SkillMatcherOptions {
  /** Minimum score threshold for a match to be included (default: 0.1) */
  threshold?: number;
}

/** Score awarded when the skill name appears as a word in the query. */
const NAME_MATCH_SCORE = 1.0;

/** Score awarded per trigger keyword/phrase found in the query. */
const TRIGGER_MATCH_SCORE = 0.6;

/** Score awarded per overlapping description word. */
const DESCRIPTION_WORD_SCORE = 0.05;

/** Score awarded when a category name appears in the query. */
const CATEGORY_MATCH_SCORE = 0.3;

/** Maximum possible score (capped). */
const MAX_SCORE = 1.0;

/**
 * Common English stop words excluded from description matching
 * to reduce false positives.
 */
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "do",
  "for",
  "from",
  "has",
  "have",
  "he",
  "her",
  "his",
  "how",
  "i",
  "if",
  "in",
  "is",
  "it",
  "its",
  "me",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "she",
  "so",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "what",
  "when",
  "which",
  "who",
  "will",
  "with",
  "you",
  "your",
]);

/**
 * Tokenize a string into lowercase words, splitting on whitespace and
 * punctuation. Returns only non-empty tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s,.!?;:'"()\[\]{}<>\/\\|@#$%^&*+=~`]+/)
    .filter((token) => token.length > 0);
}

/**
 * Tokenize and remove stop words. Used for description matching where
 * common words would cause noise.
 */
function tokenizeWithoutStopWords(text: string): string[] {
  return tokenize(text).filter((token) => !STOP_WORDS.has(token));
}

/**
 * Check whether a word appears as a standalone token in the text.
 * Uses word-boundary detection via surrounding non-alphanumeric characters.
 */
function containsWord(text: string, word: string): boolean {
  const lower = text.toLowerCase();
  const target = word.toLowerCase();
  let index = lower.indexOf(target);

  while (index !== -1) {
    const before = index === 0 || !isAlphanumeric(lower[index - 1]);
    const after =
      index + target.length >= lower.length ||
      !isAlphanumeric(lower[index + target.length]);

    if (before && after) {
      return true;
    }

    index = lower.indexOf(target, index + 1);
  }

  return false;
}

function isAlphanumeric(char: string): boolean {
  const code = char.charCodeAt(0);
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  );
}

/**
 * Matches user queries against skill metadata to identify relevant skills.
 *
 * Scoring is keyword-based and deterministic:
 * - Exact name match in query: +1.0
 * - Trigger keyword/phrase found in query: +0.6 per trigger
 * - Description word overlap (stop words removed): +0.05 per word
 * - Category name found in query: +0.3 per category
 *
 * Scores are capped at 1.0. Results below the threshold are excluded.
 * Returned matches are sorted by score descending.
 */
export class SkillMatcher {
  private readonly threshold: number;

  constructor(options?: SkillMatcherOptions) {
    this.threshold = options?.threshold ?? 0.1;
  }

  /**
   * Match a user query against a list of skills.
   * Returns ranked matches above the threshold, sorted by score descending.
   */
  match(query: string, skills: Skill[]): SkillMatch[] {
    if (query.trim().length === 0) {
      return [];
    }

    const results: SkillMatch[] = [];

    for (const skill of skills) {
      const match = this.scoreSkill(query, skill);
      if (match.score >= this.threshold) {
        results.push(match);
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Exact name match fallback — always returns the skill if found by name.
   * Ignores scoring and thresholds entirely.
   */
  matchExact(name: string, skills: Skill[]): Skill | undefined {
    const normalized = name.trim().toLowerCase();
    return skills.find((s) => s.config.name.trim().toLowerCase() === normalized);
  }

  /**
   * Compute a match score for a single skill against a query.
   */
  private scoreSkill(query: string, skill: Skill): SkillMatch {
    let score = 0;
    const matchedOn: MatchSource[] = [];

    // 1. Exact name match — skill name appears as a word in the query
    if (containsWord(query, skill.config.name)) {
      score += NAME_MATCH_SCORE;
      matchedOn.push("name");
    }

    // 2. Trigger keyword/phrase match
    for (const trigger of skill.triggers) {
      if (this.triggerMatchesQuery(query, trigger)) {
        score += TRIGGER_MATCH_SCORE;
        if (!matchedOn.includes("trigger")) {
          matchedOn.push("trigger");
        }
      }
    }

    // 3. Description word overlap (stop words removed)
    const queryWords = new Set(tokenizeWithoutStopWords(query));
    const descriptionWords = tokenizeWithoutStopWords(skill.summary.description);
    for (const word of descriptionWords) {
      if (queryWords.has(word)) {
        score += DESCRIPTION_WORD_SCORE;
        if (!matchedOn.includes("description")) {
          matchedOn.push("description");
        }
      }
    }

    // 4. Category match — category name appears as a word in the query
    for (const category of skill.categories) {
      if (containsWord(query, category)) {
        score += CATEGORY_MATCH_SCORE;
        if (!matchedOn.includes("category")) {
          matchedOn.push("category");
        }
      }
    }

    return {
      skill,
      score: Math.min(score, MAX_SCORE),
      matchedOn,
    };
  }

  /**
   * Check whether a trigger matches the query. Multi-word triggers are
   * checked as substring phrases; single-word triggers use word-boundary
   * matching to avoid partial hits.
   */
  private triggerMatchesQuery(query: string, trigger: string): boolean {
    const triggerWords = tokenize(trigger);

    if (triggerWords.length > 1) {
      // Multi-word trigger: check as a phrase substring
      return query.toLowerCase().includes(trigger.toLowerCase());
    }

    // Single-word trigger: word-boundary match
    return containsWord(query, trigger);
  }
}
