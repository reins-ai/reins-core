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

const encoder = new TextEncoder();

export function truncateOutput(
  content: string,
  options: TruncationOptions = {},
): TruncatedResult {
  const maxLines = normalizeLimit(options.maxLines, MAX_LINES);
  const maxBytes = normalizeLimit(options.maxBytes, MAX_BYTES);

  const originalBytes = encoder.encode(content).byteLength;
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
  let output = "";

  for (const char of content) {
    const charBytes = encoder.encode(char).byteLength;
    if (currentBytes + charBytes > maxBytes) {
      break;
    }

    if (char === "\n" && currentLines >= maxLines) {
      break;
    }

    output += char;
    currentBytes += charBytes;

    if (char === "\n") {
      currentLines += 1;
    }
  }

  return {
    output,
    metadata: {
      truncated: true,
      originalLines,
      originalBytes,
    },
  };
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  let lines = 1;
  for (const char of content) {
    if (char === "\n") {
      lines += 1;
    }
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
