import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { MapError, MapperOptions, MapResult } from "./types";

/**
 * Source paths for OpenClaw shared reference directories.
 */
export interface SharedRefPaths {
  /** Path to the OpenClaw shared-references/ directory. */
  sharedReferences?: string;
  /** Path to the OpenClaw templates/ directory. */
  templates?: string;
}

/**
 * Copies OpenClaw shared-references/ and templates/ directories into the
 * Reins workspace, preserving the full directory structure.
 *
 * Target layout:
 *   <targetBaseDir>/shared-references/  ← from OpenClaw shared-references/
 *   <targetBaseDir>/templates/          ← from OpenClaw templates/
 */
export class SharedRefMapper {
  private readonly targetBaseDir: string;

  constructor(targetBaseDir?: string) {
    this.targetBaseDir =
      targetBaseDir ?? join(process.env["HOME"] ?? "~", ".reins");
  }

  async map(
    sourcePaths: SharedRefPaths,
    options?: MapperOptions,
  ): Promise<MapResult> {
    let converted = 0;
    let skipped = 0;
    const errors: MapError[] = [];

    const mappings: Array<{ src: string; destSubdir: string }> = [];

    if (sourcePaths.sharedReferences) {
      mappings.push({
        src: sourcePaths.sharedReferences,
        destSubdir: "shared-references",
      });
    }

    if (sourcePaths.templates) {
      mappings.push({
        src: sourcePaths.templates,
        destSubdir: "templates",
      });
    }

    const total = mappings.length;
    let processed = 0;

    for (const { src, destSubdir } of mappings) {
      const srcExists = await directoryExists(src);

      if (!srcExists) {
        // Missing source directories are skipped gracefully — not an error.
        skipped++;
        processed++;
        options?.onProgress?.(processed, total);
        continue;
      }

      const destBase = join(this.targetBaseDir, destSubdir);
      const files = await collectAllFiles(src);

      for (const absoluteSrc of files) {
        const relativePath = relative(src, absoluteSrc);
        const absoluteDest = join(destBase, relativePath);

        try {
          if (!options?.dryRun) {
            const destDir = join(absoluteDest, "..");
            await mkdir(destDir, { recursive: true });

            const content = await Bun.file(absoluteSrc).arrayBuffer();
            await Bun.write(absoluteDest, content);
          }

          converted++;
        } catch (error) {
          errors.push({
            item: relativePath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (files.length === 0) {
        skipped++;
      }

      processed++;
      options?.onProgress?.(processed, total);
    }

    return { converted, skipped, errors };
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Recursively collects absolute paths of all files under `dir`.
 * Uses `readdir` with `{ recursive: true }` (Bun / Node 18+) which returns
 * relative paths from the given root.
 */
async function collectAllFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  const results: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(dir, entry as string);
    try {
      const info = await stat(absolutePath);
      if (info.isFile()) {
        results.push(absolutePath);
      }
    } catch {
      // Skip entries that can't be stat'd.
    }
  }

  return results;
}
