/**
 * Obsidian list-notes operation.
 *
 * Lists Markdown notes in a directory within the vault.
 * Supports optional recursive listing and defaults to the vault root.
 * Returns dual-channel IntegrationResult with compact forModel (file names)
 * and rich forUser (with metadata like size and modification date).
 */

import { readdir, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatListResult, type IntegrationResult } from "../../../result";

export interface ListNotesParams {
  folder?: string;
  recursive?: boolean;
}

interface NoteEntryCompact {
  title: string;
  path: string;
}

interface NoteEntryRich {
  title: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
  isInSubfolder: boolean;
}

/**
 * Derive a note title from a relative path (filename without .md extension).
 */
function titleFromPath(relativePath: string): string {
  const segments = relativePath.split("/");
  const filename = segments[segments.length - 1] ?? relativePath;
  return filename.replace(/\.md$/i, "");
}

/**
 * Validate that the resolved path stays within the vault directory.
 */
function isWithinVault(vaultPath: string, resolvedPath: string): boolean {
  const normalizedVault = resolve(vaultPath);
  const normalizedTarget = resolve(resolvedPath);
  return normalizedTarget.startsWith(normalizedVault);
}

/**
 * Collect .md files from a directory, optionally recursing into subdirectories.
 */
async function collectNotes(
  dir: string,
  vaultPath: string,
  recursive: boolean,
): Promise<NoteEntryRich[]> {
  const results: NoteEntryRich[] = [];
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

    if (fileStat.isDirectory() && recursive) {
      const nested = await collectNotes(fullPath, vaultPath, true);
      results.push(...nested);
    } else if (fileStat.isFile() && entry.endsWith(".md")) {
      const relativePath = relative(vaultPath, fullPath);
      results.push({
        title: titleFromPath(relativePath),
        path: relativePath,
        sizeBytes: fileStat.size,
        modifiedAt: fileStat.mtime.toISOString(),
        createdAt: fileStat.birthtime.toISOString(),
        isInSubfolder: relativePath.includes("/"),
      });
    }
  }

  return results;
}

/**
 * List notes in a vault directory.
 */
export async function listNotes(
  vaultPath: string,
  params: ListNotesParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const folder = params.folder?.trim() ?? "";
  const recursive = params.recursive ?? false;

  const targetDir = folder.length > 0 ? join(vaultPath, folder) : vaultPath;

  if (!isWithinVault(vaultPath, targetDir)) {
    return err(
      new IntegrationError("Folder path must be within the vault directory"),
    );
  }

  // Verify the target directory exists
  try {
    const dirStat = await stat(targetDir);
    if (!dirStat.isDirectory()) {
      return err(
        new IntegrationError(`Path is not a directory: ${folder || "vault root"}`),
      );
    }
  } catch {
    return err(
      new IntegrationError(`Directory not found: ${folder || "vault root"}`),
    );
  }

  let notes: NoteEntryRich[];
  try {
    notes = await collectNotes(targetDir, vaultPath, recursive);
  } catch (cause) {
    return err(
      new IntegrationError(
        `Failed to list notes in: ${folder || "vault root"}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  // Sort by modification date (most recent first)
  notes.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  const folderLabel = folder.length > 0 ? folder : "vault root";

  const result = formatListResult<NoteEntryRich, NoteEntryCompact, NoteEntryRich>({
    entityName: "notes",
    items: notes,
    toModel: (item) => ({
      title: item.title,
      path: item.path,
    }),
    toUser: (item) => item,
    title: `Notes in ${folderLabel}`,
    emptyMessage: `No notes found in ${folderLabel}.`,
    metadata: { folder: folderLabel, recursive, totalCount: notes.length },
  });

  return ok(result);
}
