export const MAX_LINES = 2000;
export const MAX_BYTES = 50 * 1024;

interface TruncationOptions {
  maxLines?: number;
  maxBytes?: number;
}

interface TruncationMetadata {
  truncated: boolean;
  originalLines: number;
  originalBytes: number;
}

export interface TruncatedResult {
  output: string;
  metadata: TruncationMetadata;
}

export function truncateOutput(
  content: string,
  options: TruncationOptions = {},
): TruncatedResult {
  const maxLines = normalizeLimit(options.maxLines, MAX_LINES);
  const maxBytes = normalizeLimit(options.maxBytes, MAX_BYTES);

  const originalBytes = Buffer.byteLength(content, "utf8");
  const originalLines = countLines(content);

  if (originalLines <= maxLines && originalBytes <= maxBytes) {
    return {
      output: content,
      metadata: {
        truncated: false,
        originalLines,
        originalBytes,
      },
    };
  }

  let currentBytes = 0;
  let currentLines = content.length === 0 ? 0 : 1;
  let endIndex = 0;

  for (const char of content) {
    const charBytes = codePointByteLength(char.codePointAt(0)!);
    if (currentBytes + charBytes > maxBytes) {
      break;
    }

    if (char === "\n" && currentLines >= maxLines) {
      break;
    }

    endIndex += char.length;
    currentBytes += charBytes;

    if (char === "\n") {
      currentLines += 1;
    }
  }

  return {
    output: content.slice(0, endIndex),
    metadata: {
      truncated: true,
      originalLines,
      originalBytes,
    },
  };
}

function codePointByteLength(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  let lines = 1;
  let index = -1;
  while ((index = content.indexOf("\n", index + 1)) !== -1) {
    lines += 1;
  }

  return lines;
}

function normalizeLimit(limit: number | undefined, fallback: number): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return fallback;
  }

  const normalized = Math.floor(limit);
  if (normalized < 0) {
    return 0;
  }

  return normalized;
}
