/**
 * Obsidian search-notes operation.
 *
 * Searches all .md files in the vault for content and title matches
 * using case-insensitive string matching. Returns dual-channel
 * IntegrationResult with compact forModel and rich forUser.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatListResult, type IntegrationResult } from "../../../result";

const DEFAULT_SEARCH_LIMIT = 20;
const SNIPPET_CONTEXT_CHARS = 120;

export interface SearchNotesParams {
  query: string;
  limit?: number;
}

export interface SearchNoteMatch {
  title: string;
  path: string;
  snippet: string;
  matchType: "title" | "content" | "both";
}

interface SearchNoteMatchRich extends SearchNoteMatch {
  fullContent: string;
  sizeBytes: number;
  modifiedAt: string;
}

/**
 * Collect all .md file paths recursively from a directory.
 */
async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Skip hidden directories and files (e.g. .obsidian, .trash)
    if (entry.startsWith(".")) {
      continue;
    }

    const fullPath = join(dir, entry);
    let fileStat;

    try {
      fileStat = await stat(fullPath);
    } catch {
      continue;
    }

    if (fileStat.isDirectory()) {
      const nested = await collectMarkdownFiles(fullPath);
      results.push(...nested);
    } else if (entry.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}

/**
 * Extract a snippet around the first match of a query in content.
 * Returns a trimmed excerpt with surrounding context.
 */
function extractSnippet(content: string, query: string): string {
  const lowerContent = content.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerContent.indexOf(lowerQuery);

  if (matchIndex === -1) {
    // No content match — return first N chars as preview
    const preview = content.slice(0, SNIPPET_CONTEXT_CHARS * 2).trim();
    return preview.length < content.length ? `${preview}...` : preview;
  }

  const start = Math.max(0, matchIndex - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(content.length, matchIndex + query.length + SNIPPET_CONTEXT_CHARS);
  let snippet = content.slice(start, end).trim();

  if (start > 0) {
    snippet = `...${snippet}`;
  }
  if (end < content.length) {
    snippet = `${snippet}...`;
  }

  return snippet;
}

/**
 * Derive a note title from a file path (filename without .md extension).
 */
function titleFromPath(filePath: string): string {
  const segments = filePath.split("/");
  const filename = segments[segments.length - 1] ?? filePath;
  return filename.replace(/\.md$/i, "");
}

/**
 * Search notes in the vault by content and title.
 */
export async function searchNotes(
  vaultPath: string,
  params: SearchNotesParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const query = params.query.trim();
  if (query.length === 0) {
    return err(new IntegrationError("Search query must not be empty"));
  }

  const limit = params.limit ?? DEFAULT_SEARCH_LIMIT;
  const lowerQuery = query.toLowerCase();

  let filePaths: string[];
  try {
    filePaths = await collectMarkdownFiles(vaultPath);
  } catch (cause) {
    return err(
      new IntegrationError(
        `Failed to scan vault directory: ${vaultPath}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  const matches: SearchNoteMatchRich[] = [];

  for (const filePath of filePaths) {
    if (matches.length >= limit) {
      break;
    }

    const relativePath = relative(vaultPath, filePath);
    const title = titleFromPath(relativePath);
    const titleMatch = title.toLowerCase().includes(lowerQuery);

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const contentMatch = content.toLowerCase().includes(lowerQuery);

    if (!titleMatch && !contentMatch) {
      continue;
    }

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      continue;
    }

    const matchType: SearchNoteMatch["matchType"] =
      titleMatch && contentMatch ? "both" : titleMatch ? "title" : "content";

    matches.push({
      title,
      path: relativePath,
      snippet: extractSnippet(content, query),
      matchType,
      fullContent: content,
      sizeBytes: fileStat.size,
      modifiedAt: fileStat.mtime.toISOString(),
    });
  }

  const result = formatListResult<
    SearchNoteMatchRich,
    SearchNoteMatch,
    SearchNoteMatchRich
  >({
    entityName: "notes",
    items: matches,
    toModel: (item) => ({
      title: item.title,
      path: item.path,
      snippet: item.snippet,
      matchType: item.matchType,
    }),
    toUser: (item) => item,
    title: `Search Results for "${query}"`,
    emptyMessage: `No notes matching "${query}" found in vault.`,
    metadata: { query, limit, totalScanned: filePaths.length },
  });

  return ok(result);
}
