import type { DiscordEmbed } from "./discord/types";

/**
 * Maximum character length for a single Discord message.
 */
const DISCORD_MAX_MESSAGE_LENGTH = 2_000;

/**
 * Maximum character length for a Discord embed description.
 */
const DISCORD_MAX_EMBED_DESCRIPTION = 4_096;

/**
 * Maximum character length for a Discord embed title.
 */
const DISCORD_MAX_EMBED_TITLE = 256;

/**
 * Default embed color (Reins brand blue).
 */
const DEFAULT_EMBED_COLOR = 0x5865f2;

/**
 * Characters that must be escaped in Telegram MarkdownV2 outside of
 * code blocks and pre-formatted blocks.
 *
 * See: https://core.telegram.org/bots/api#markdownv2-style
 */
const TELEGRAM_SPECIAL_CHARS = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/**
 * Options for creating a Discord embed.
 */
export interface DiscordEmbedOptions {
  title?: string;
  color?: number;
  footer?: string;
  timestamp?: boolean;
}

/**
 * Result of formatting for Discord when the message may need chunking.
 */
export interface DiscordFormattedResult {
  content: string;
  chunks?: string[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Escape a string for Telegram MarkdownV2 outside of code spans/blocks.
 */
function escapeTelegramChars(text: string): string {
  return text.replace(TELEGRAM_SPECIAL_CHARS, "\\$1");
}

/**
 * Represents a segment of the input: either a code block / inline code
 * that should be preserved verbatim, or regular text that needs conversion.
 */
interface Segment {
  type: "code_block" | "inline_code" | "text";
  raw: string;
}

/**
 * Split markdown into segments of code blocks, inline code, and regular text.
 *
 * Code blocks (triple backtick) and inline code (single backtick) are
 * extracted first so that formatting rules are not applied inside them.
 */
function segmentMarkdown(markdown: string): Segment[] {
  const segments: Segment[] = [];
  // Match fenced code blocks (``` ... ```) or inline code (` ... `)
  // Fenced blocks may include a language hint on the opening line.
  const codePattern = /(```[\s\S]*?```|`[^`\n]+`)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(markdown)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: "text", raw: markdown.slice(lastIndex, match.index) });
    }

    const raw = match[0]!;
    const isBlock = raw.startsWith("```");
    segments.push({ type: isBlock ? "code_block" : "inline_code", raw });
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < markdown.length) {
    segments.push({ type: "text", raw: markdown.slice(lastIndex) });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Telegram MarkdownV2
// ---------------------------------------------------------------------------

/**
 * Convert list markers (`- item` / `* item`) to bullet characters.
 * Telegram MarkdownV2 has no native list support.
 */
function convertListsForTelegram(text: string): string {
  return text.replace(/^(\s*)[*-]\s+/gm, "$1• ");
}

/**
 * Convert a text segment (non-code) from standard Markdown to Telegram
 * MarkdownV2 syntax.
 *
 * Processing order matters:
 * 1. Extract and convert links (before escaping)
 * 2. Convert bold markers (`**` → `*`)
 * 3. Convert strikethrough markers (`~~` → `~`)
 * 4. Convert italic markers (single `*` → `_`)
 * 5. Convert list markers
 * 6. Escape remaining special characters
 */
function convertTextSegmentForTelegram(text: string): string {
  // Step 1: Extract links and replace with placeholders
  const links: Array<{ placeholder: string; replacement: string }> = [];
  let linkIndex = 0;
  let processed = text.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_match, linkText: string, url: string) => {
      const placeholder = `\x00LINK${linkIndex}\x00`;
      const escapedText = escapeTelegramChars(linkText);
      const escapedUrl = url.replace(/([)\\])/g, "\\$1");
      links.push({ placeholder, replacement: `[${escapedText}](${escapedUrl})` });
      linkIndex++;
      return placeholder;
    },
  );

  // Step 2: Convert bold (**text** → *text*) before escaping
  const bolds: Array<{ placeholder: string; replacement: string }> = [];
  let boldIndex = 0;
  processed = processed.replace(/\*\*(.+?)\*\*/g, (_match, inner: string) => {
    const placeholder = `\x00BOLD${boldIndex}\x00`;
    bolds.push({ placeholder, replacement: `*${escapeTelegramChars(inner)}*` });
    boldIndex++;
    return placeholder;
  });

  // Step 3: Convert strikethrough (~~text~~ → ~text~) before escaping
  const strikes: Array<{ placeholder: string; replacement: string }> = [];
  let strikeIndex = 0;
  processed = processed.replace(/~~(.+?)~~/g, (_match, inner: string) => {
    const placeholder = `\x00STRIKE${strikeIndex}\x00`;
    strikes.push({ placeholder, replacement: `~${escapeTelegramChars(inner)}~` });
    strikeIndex++;
    return placeholder;
  });

  // Step 4: Convert single-asterisk italic (*text* → _text_) before escaping
  const italics: Array<{ placeholder: string; replacement: string }> = [];
  let italicIndex = 0;
  processed = processed.replace(
    /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g,
    (_match, inner: string) => {
      const placeholder = `\x00ITALIC${italicIndex}\x00`;
      italics.push({ placeholder, replacement: `_${escapeTelegramChars(inner)}_` });
      italicIndex++;
      return placeholder;
    },
  );

  // Step 5: Convert underscore italic (_text_ → _text_) before escaping
  const underscoreItalics: Array<{ placeholder: string; replacement: string }> = [];
  let uItalicIndex = 0;
  processed = processed.replace(
    /(?<!_)_(?!_)(.+?)(?<!_)_(?!_)/g,
    (_match, inner: string) => {
      const placeholder = `\x00UITALIC${uItalicIndex}\x00`;
      underscoreItalics.push({ placeholder, replacement: `_${escapeTelegramChars(inner)}_` });
      uItalicIndex++;
      return placeholder;
    },
  );

  // Step 6: Convert list markers
  processed = convertListsForTelegram(processed);

  // Step 7: Escape remaining special characters
  processed = escapeTelegramChars(processed);

  // Step 8: Restore placeholders in reverse order
  for (const { placeholder, replacement } of underscoreItalics) {
    processed = processed.replace(placeholder, replacement);
  }
  for (const { placeholder, replacement } of italics) {
    processed = processed.replace(placeholder, replacement);
  }
  for (const { placeholder, replacement } of strikes) {
    processed = processed.replace(placeholder, replacement);
  }
  for (const { placeholder, replacement } of bolds) {
    processed = processed.replace(placeholder, replacement);
  }
  for (const { placeholder, replacement } of links) {
    processed = processed.replace(placeholder, replacement);
  }

  return processed;
}

/**
 * Convert a fenced code block to Telegram MarkdownV2 format.
 *
 * Telegram uses the same triple-backtick syntax but the content inside
 * must NOT be escaped. Language hints are preserved.
 */
function convertCodeBlockForTelegram(raw: string): string {
  // Already in ``` ... ``` format — Telegram accepts this as-is.
  // Content inside code blocks must not be escaped.
  return raw;
}

/**
 * Convert an inline code span to Telegram MarkdownV2 format.
 *
 * Telegram uses the same single-backtick syntax. Content inside
 * must NOT be escaped.
 */
function convertInlineCodeForTelegram(raw: string): string {
  return raw;
}

/**
 * Convert standard Markdown to Telegram MarkdownV2 format.
 *
 * Handles:
 * - Bold (`**text**` → `*text*`)
 * - Italic (`*text*` or `_text_` → `_text_`)
 * - Strikethrough (`~~text~~` → `~text~`)
 * - Code blocks (preserved with language hints)
 * - Inline code (preserved)
 * - Links (`[text](url)` → `[text](url)` with proper escaping)
 * - Lists (`- item` → `• item`)
 * - Special character escaping for all other MarkdownV2 reserved chars
 *
 * Returns an empty string for empty/whitespace-only input.
 */
export function formatForTelegram(markdown: string): string {
  if (markdown.length === 0) {
    return "";
  }

  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const segments = segmentMarkdown(markdown);
  const converted: string[] = [];

  for (const segment of segments) {
    switch (segment.type) {
      case "code_block":
        converted.push(convertCodeBlockForTelegram(segment.raw));
        break;
      case "inline_code":
        converted.push(convertInlineCodeForTelegram(segment.raw));
        break;
      case "text":
        converted.push(convertTextSegmentForTelegram(segment.raw));
        break;
    }
  }

  return converted.join("");
}

// ---------------------------------------------------------------------------
// Discord Markdown
// ---------------------------------------------------------------------------

/**
 * Convert standard Markdown to Discord-compatible markdown.
 *
 * Discord's markdown is very close to standard markdown, so minimal
 * conversion is needed. Key differences handled:
 * - Code blocks with language hints are preserved
 * - Links are ensured to be in `[text](url)` format
 * - Underline syntax (`__text__`) is preserved (Discord extension)
 *
 * Returns an empty string for empty/whitespace-only input.
 */
export function formatForDiscord(markdown: string): string {
  if (markdown.length === 0) {
    return "";
  }

  const trimmed = markdown.trim();
  if (trimmed.length === 0) {
    return "";
  }

  // Discord markdown is very close to standard — mostly passthrough.
  // Ensure bare URLs are not double-wrapped in link syntax.
  let result = markdown;

  // Convert HTML-style links to markdown links if present
  result = result.replace(
    /<a\s+href="([^"]+)"[^>]*>([^<]+)<\/a>/gi,
    (_match, url: string, text: string) => `[${text}](${url})`,
  );

  return result;
}

/**
 * Split a Discord message into chunks that respect the 2000-character limit.
 *
 * Splits prefer line boundaries when possible to avoid breaking
 * mid-sentence. Falls back to hard split at the limit.
 */
export function chunkDiscordMessage(
  text: string,
  maxLength: number = DISCORD_MAX_MESSAGE_LENGTH,
): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex <= 0 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIndex <= 0 || splitIndex < maxLength * 0.5) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).replace(/^\n/, "");
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Discord Embeds
// ---------------------------------------------------------------------------

/**
 * Create a Discord embed object for rich agent responses.
 *
 * Handles:
 * - Title truncation to 256 characters
 * - Description truncation to 4096 characters
 * - Optional color, footer, and timestamp
 * - Empty content returns `null`
 *
 * @param content - The main text content for the embed description
 * @param options - Optional embed configuration
 * @returns A Discord embed object, or `null` if content is empty
 */
export function createDiscordEmbed(
  content: string,
  options: DiscordEmbedOptions = {},
): DiscordEmbed | null {
  if (content.length === 0) {
    return null;
  }

  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const embed: DiscordEmbed = {
    color: options.color ?? DEFAULT_EMBED_COLOR,
  };

  // Truncate description to Discord's limit
  if (trimmed.length > DISCORD_MAX_EMBED_DESCRIPTION) {
    embed.description = trimmed.slice(0, DISCORD_MAX_EMBED_DESCRIPTION - 3) + "...";
  } else {
    embed.description = trimmed;
  }

  // Add title if provided, truncated to limit
  if (options.title !== undefined) {
    if (options.title.length > DISCORD_MAX_EMBED_TITLE) {
      embed.title = options.title.slice(0, DISCORD_MAX_EMBED_TITLE - 3) + "...";
    } else {
      embed.title = options.title;
    }
  }

  // Add footer if provided
  if (options.footer !== undefined) {
    embed.footer = { text: options.footer };
  }

  // Add timestamp if requested
  if (options.timestamp === true) {
    embed.timestamp = new Date().toISOString();
  }

  return embed;
}
