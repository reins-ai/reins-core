/**
 * Obsidian create-note operation.
 *
 * Creates a new Markdown file in the vault with a title and content.
 * Returns dual-channel IntegrationResult confirming creation with
 * compact forModel (path, title) and rich forUser (full details).
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ok, err, type Result } from "../../../../result";
import { IntegrationError } from "../../../errors";
import { formatDetailResult, type IntegrationResult } from "../../../result";

export interface CreateNoteParams {
  title: string;
  content: string;
  folder?: string;
}

interface CreatedNoteCompact {
  path: string;
  title: string;
}

interface CreatedNoteRich {
  path: string;
  title: string;
  content: string;
  sizeBytes: number;
  createdAt: string;
}

/**
 * Sanitize a title for use as a filename.
 * Removes characters that are invalid in most filesystems.
 */
function sanitizeFilename(title: string): string {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
 * Check if a file already exists at the given path.
 */
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create a new Markdown note in the vault.
 */
export async function createNote(
  vaultPath: string,
  params: CreateNoteParams,
): Promise<Result<IntegrationResult, IntegrationError>> {
  const title = params.title.trim();
  if (title.length === 0) {
    return err(new IntegrationError("Note title must not be empty"));
  }

  const content = params.content;
  const folder = params.folder?.trim() ?? "";

  const sanitized = sanitizeFilename(title);
  if (sanitized.length === 0) {
    return err(
      new IntegrationError("Note title contains only invalid characters"),
    );
  }

  const filename = sanitized.endsWith(".md") ? sanitized : `${sanitized}.md`;
  const relativePath = folder.length > 0 ? join(folder, filename) : filename;
  const fullPath = join(vaultPath, relativePath);

  if (!isWithinVault(vaultPath, fullPath)) {
    return err(
      new IntegrationError("Note path must be within the vault directory"),
    );
  }

  if (await fileExists(fullPath)) {
    return err(
      new IntegrationError(`A note already exists at: ${relativePath}`),
    );
  }

  // Ensure the target directory exists
  const targetDir = dirname(fullPath);
  try {
    await mkdir(targetDir, { recursive: true });
  } catch (cause) {
    return err(
      new IntegrationError(
        `Failed to create directory: ${dirname(relativePath)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  // Write the note with a Markdown title heading
  const noteContent = `# ${title}\n\n${content}`;

  try {
    await writeFile(fullPath, noteContent, "utf-8");
  } catch (cause) {
    return err(
      new IntegrationError(
        `Failed to write note: ${relativePath}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  const createdAt = new Date().toISOString();
  const sizeBytes = Buffer.byteLength(noteContent, "utf-8");

  const rawNote = {
    path: relativePath,
    title,
    content: noteContent,
    sizeBytes,
    createdAt,
  };

  const result = formatDetailResult<typeof rawNote, CreatedNoteCompact, CreatedNoteRich>({
    entityName: "note",
    item: rawNote,
    toModel: (item) => ({
      path: item.path,
      title: item.title,
    }),
    toUser: (item) => ({
      path: item.path,
      title: item.title,
      content: item.content,
      sizeBytes: item.sizeBytes,
      createdAt: item.createdAt,
    }),
    title: `Created: ${title}`,
    message: `Note "${title}" created at ${relativePath}`,
    metadata: { sizeBytes, createdAt },
  });

  return ok(result);
}
