/**
 * Parses and sanitizes user search queries for safe FTS5 MATCH usage.
 *
 * Supports:
 * - Quoted phrase search: "exact phrase"
 * - Prefix matching: word*
 * - Multiple terms (implicit AND)
 *
 * Strips all raw FTS5 operators (AND, OR, NOT, NEAR, column filters)
 * to prevent injection of arbitrary FTS5 syntax.
 */

const FTS5_OPERATORS = /\b(AND|OR|NOT|NEAR)\b/gi;
const FTS5_UNSAFE_CHARS = /[{}()^:+\-~@#$%&|\\!<>=[\]]/g;
const MULTIPLE_SPACES = /\s{2,}/g;
const DANGLING_ASTERISKS = /(?<!\w)\*/g;

function extractPhrases(raw: string): { phrases: string[]; remainder: string } {
  const phrases: string[] = [];
  let remainder = raw;

  const phrasePattern = /"([^"]+)"/g;
  let match: RegExpExecArray | null;

  while ((match = phrasePattern.exec(raw)) !== null) {
    const phrase = match[1]?.trim();
    if (phrase && phrase.length > 0) {
      phrases.push(phrase);
    }
  }

  remainder = remainder.replace(/"[^"]*"/g, " ");
  return { phrases, remainder };
}

function sanitizeToken(token: string): string {
  let cleaned = token.replace(FTS5_UNSAFE_CHARS, "");
  cleaned = cleaned.replace(FTS5_OPERATORS, "");
  cleaned = cleaned.replace(DANGLING_ASTERISKS, "");
  cleaned = cleaned.trim();
  return cleaned;
}

function tokenize(text: string): string[] {
  return text
    .replace(MULTIPLE_SPACES, " ")
    .trim()
    .split(" ")
    .map((token) => {
      const isPrefix = token.endsWith("*");
      const base = isPrefix ? token.slice(0, -1) : token;
      const sanitized = sanitizeToken(base);

      if (!sanitized) {
        return "";
      }

      return isPrefix ? `${sanitized}*` : sanitized;
    })
    .filter((token) => token.length > 0);
}

export function parseSearchQuery(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  const { phrases, remainder } = extractPhrases(trimmed);
  const tokens = tokenize(remainder);

  const parts: string[] = [];

  for (const phrase of phrases) {
    const sanitizedPhrase = sanitizeToken(phrase);
    if (sanitizedPhrase) {
      parts.push(`"${sanitizedPhrase}"`);
    }
  }

  for (const token of tokens) {
    parts.push(token);
  }

  return parts.join(" ");
}
