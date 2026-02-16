import { mkdir, mkdtemp, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok, type Result } from "../../result";
import { MarketplaceError, MARKETPLACE_ERROR_CODES } from "../errors";
import type { DownloadResult } from "../types";

/**
 * Result of extracting a downloaded skill zip.
 */
export interface ExtractionResult {
  /** Absolute path to the directory containing extracted files. */
  extractedPath: string;
  /** List of file and directory names at the extraction root. */
  files: string[];
  /** Whether a SKILL.md file was found in the extracted contents. */
  hasSkillMd: boolean;
}

/**
 * Recursively searches for SKILL.md in a directory tree.
 * Returns the directory containing SKILL.md, or null if not found.
 */
async function findSkillMdDir(dir: string): Promise<string | null> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() && entry.name === "SKILL.md") {
      return dir;
    }
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = await findSkillMdDir(join(dir, entry.name));
      if (found) {
        return found;
      }
    }
  }

  return null;
}

/**
 * Extracts a downloaded skill zip to a staging directory and validates
 * that the extracted contents include a SKILL.md file.
 *
 * When the zip contains a single top-level directory, the extraction
 * result points to that subdirectory so callers always receive the
 * directory that directly contains the skill files.
 */
export async function downloadAndExtract(
  downloadResult: DownloadResult,
): Promise<Result<ExtractionResult>> {
  const buffer = downloadResult.buffer instanceof ArrayBuffer
    ? new Uint8Array(downloadResult.buffer)
    : downloadResult.buffer;

  if (buffer.length === 0) {
    return err(
      new MarketplaceError(
        "Downloaded skill package is empty",
        MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR,
      ),
    );
  }

  let tempDir: string;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "reins-skill-"));
  } catch (cause) {
    return err(
      new MarketplaceError(
        "Failed to create temporary directory for extraction",
        MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }

  const zipPath = join(tempDir, downloadResult.filename || "skill.zip");
  const extractDir = join(tempDir, "extracted");

  try {
    await writeFile(zipPath, buffer);
    await mkdir(extractDir, { recursive: true });

    const proc = Bun.spawn(["unzip", "-o", zipPath, "-d", extractDir], {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return err(
        new MarketplaceError(
          `Failed to extract skill package: unzip exited with code ${exitCode}${stderr ? ` — ${stderr.trim()}` : ""}`,
          MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR,
        ),
      );
    }

    const topEntries = await readdir(extractDir);

    if (topEntries.length === 0) {
      return err(
        new MarketplaceError(
          "Extracted skill package is empty",
          MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR,
        ),
      );
    }

    // If the zip contains a single top-level directory, descend into it
    let effectiveDir = extractDir;
    if (topEntries.length === 1) {
      const singleEntry = join(extractDir, topEntries[0]);
      const entryStat = await stat(singleEntry);
      if (entryStat.isDirectory()) {
        effectiveDir = singleEntry;
      }
    }

    const files = await readdir(effectiveDir);
    const hasSkillMd = files.includes("SKILL.md");

    if (!hasSkillMd) {
      // Deep search in case SKILL.md is nested further
      const skillMdDir = await findSkillMdDir(effectiveDir);
      if (skillMdDir) {
        const nestedFiles = await readdir(skillMdDir);
        return ok({
          extractedPath: skillMdDir,
          files: nestedFiles,
          hasSkillMd: true,
        });
      }

      return err(
        new MarketplaceError(
          "Extracted skill package does not contain a SKILL.md file",
          MARKETPLACE_ERROR_CODES.INVALID_RESPONSE,
        ),
      );
    }

    return ok({
      extractedPath: effectiveDir,
      files,
      hasSkillMd: true,
    });
  } catch (cause) {
    return err(
      new MarketplaceError(
        `Skill extraction failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        MARKETPLACE_ERROR_CODES.DOWNLOAD_ERROR,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }
}
