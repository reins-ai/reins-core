/**
 * Obsidian read-note operation.
 *
 * Reads the content of a Markdown note by its path relative to the vault root.
 * Returns dual-channel IntegrationResult with compact forModel (path, length)
 * and rich forUser (full Markdown content with metadata).
 */

import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatDetailResult, type IntegrationResult } from "../../../result";

export interface ReadNoteParams {
  path: string;
}

interface NoteCompact {
  path: string;
  title: string;
  length: number;
}

interface NoteRich {
  path: string;
  title: string;
  content: string;
  sizeBytes: number;
  modifiedAt: string;
  createdAt: string;
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
 * Validate that the resolved path stays within the vault directory
 * to prevent path traversal attacks.
 */
function isWithinVault(vaultPath: string, resolvedPath: string): boolean {
  const normalizedVault = resolve(vaultPath);
  const normalizedTarget = resolve(resolvedPath);
  return normalizedTarget.startsWith(normalizedVault);
}

/**
 * Read a note from the vault by its relative path.
 */
export async function readNote(
  vaultPath: string,
  params: ReadNoteParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const notePath = params.path.trim();
  if (notePath.length === 0) {
    return err(new IntegrationError("Note path must not be empty"));
  }

  const fullPath = join(vaultPath, notePath);

  if (!isWithinVault(vaultPath, fullPath)) {
    return err(
      new IntegrationError("Note path must be within the vault directory"),
    );
  }

  let content: string;
  try {
    content = await readFile(fullPath, "utf-8");
  } catch {
    return err(
      new IntegrationError(`Note not found: ${notePath}`),
    );
  }

  let fileStat;
  try {
    fileStat = await stat(fullPath);
  } catch {
    return err(
      new IntegrationError(`Unable to read note metadata: ${notePath}`),
    );
  }

  const title = titleFromPath(notePath);

  const rawNote = {
    path: notePath,
    title,
    content,
    sizeBytes: fileStat.size,
    modifiedAt: fileStat.mtime.toISOString(),
    createdAt: fileStat.birthtime.toISOString(),
  };

  const result = formatDetailResult<typeof rawNote, NoteCompact, NoteRich>({
    entityName: "note",
    item: rawNote,
    toModel: (item) => ({
      path: item.path,
      title: item.title,
      length: item.content.length,
    }),
    toUser: (item) => ({
      path: item.path,
      title: item.title,
      content: item.content,
      sizeBytes: item.sizeBytes,
      modifiedAt: item.modifiedAt,
      createdAt: item.createdAt,
    }),
    title: title,
    message: `Note "${title}" (${content.length} characters)`,
    metadata: { sizeBytes: fileStat.size, modifiedAt: fileStat.mtime.toISOString() },
  });

  return ok(result);
}
