import { isAbsolute, relative, resolve } from "node:path";

/**
 * Policy configuration for document source indexing.
 * Controls which files are included/excluded, size limits, and watch behavior.
 */
export interface DocumentSourcePolicy {
  /** Glob patterns for files to include (e.g. ["**\/*.md"]) */
  includePaths: string[];
  /** Glob patterns for files to exclude (e.g. ["**\/node_modules/**"]) */
  excludePaths: string[];
  /** Maximum file size in bytes (files larger than this are skipped) */
  maxFileSize: number;
  /** Maximum directory recursion depth */
  maxDepth: number;
  /** Whether to watch for file changes and re-index automatically */
  watchForChanges: boolean;
}

export const DEFAULT_SOURCE_POLICY: DocumentSourcePolicy = {
  includePaths: ["**/*.md"],
  excludePaths: [
    "**/node_modules/**",
    "**/.git/**",
    "**/dist/**",
    "**/build/**",
    "**/.goopspec/**",
  ],
  maxFileSize: 1_048_576, // 1 MB
  maxDepth: 10,
  watchForChanges: true,
};

/**
 * Convert a simple glob pattern to a RegExp.
 *
 * Supports:
 * - `**` matches any number of path segments (including zero)
 * - `*` matches any characters within a single path segment (no `/`)
 * - `.` is escaped
 * - `?` matches a single non-separator character
 *
 * This is intentionally minimal to avoid external dependencies.
 */
function globToRegExp(pattern: string): RegExp {
  let regexStr = "^";
  let i = 0;

  while (i < pattern.length) {
    const char = pattern[i];

    if (char === "*" && pattern[i + 1] === "*") {
      // ** — match any path segments
      if (pattern[i + 2] === "/") {
        regexStr += "(?:.+/)?";
        i += 3;
      } else {
        regexStr += ".*";
        i += 2;
      }
    } else if (char === "*") {
      // * — match within a single segment
      regexStr += "[^/]*";
      i++;
    } else if (char === "?") {
      regexStr += "[^/]";
      i++;
    } else if (char === ".") {
      regexStr += "\\.";
      i++;
    } else {
      regexStr += char;
      i++;
    }
  }

  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Normalize a file path for consistent matching.
 * Strips leading `./` and converts backslashes to forward slashes.
 */
function normalizePath(filePath: string): string {
  let normalized = filePath.replace(/\\/g, "/");
  if (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

/**
 * Check whether a file path is safely contained within a source root.
 * Returns false if the path escapes the root via traversal or is an external absolute path.
 */
export function isContainedInRoot(filePath: string, sourceRoot: string): boolean {
  const canonicalRoot = resolve(sourceRoot);
  const canonicalPath = resolve(sourceRoot, filePath);
  const rel = relative(canonicalRoot, canonicalPath);

  // Path escapes root if relative path starts with ".." or is absolute
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return false;
  }

  return true;
}

/**
 * Check whether a file path matches the include/exclude rules of a policy.
 *
 * A path matches if:
 * 1. It is contained within the source root (no traversal escape)
 * 2. It matches at least one include pattern (or includePaths is empty)
 * 3. It does NOT match any exclude pattern
 *
 * When sourceRoot is provided, canonical path containment is enforced before
 * include/exclude matching.
 */
export function matchesPolicy(
  filePath: string,
  policy: DocumentSourcePolicy,
  sourceRoot?: string,
): boolean {
  // Enforce root containment when sourceRoot is provided
  if (sourceRoot !== undefined) {
    if (!isContainedInRoot(filePath, sourceRoot)) {
      return false;
    }
  }

  const normalized = normalizePath(filePath);

  // Check excludes first — any match means rejected
  for (const pattern of policy.excludePaths) {
    if (globToRegExp(pattern).test(normalized)) {
      return false;
    }
  }

  // If no include patterns, everything passes
  if (policy.includePaths.length === 0) {
    return true;
  }

  // Must match at least one include pattern
  for (const pattern of policy.includePaths) {
    if (globToRegExp(pattern).test(normalized)) {
      return true;
    }
  }

  return false;
}
