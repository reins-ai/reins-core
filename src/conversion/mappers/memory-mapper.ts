import { mkdir, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { AgentWorkspaceManager } from "../../agents/workspace";
import type { MapError, MapperOptions, MapResult } from "./types";

/**
 * Maps an OpenClaw workspace directory to a Reins agent workspace.
 */
export interface WorkspaceMapping {
  openClawPath: string;
  reinsAgentId: string;
}

/**
 * Copies all .md files from OpenClaw agent workspaces to the corresponding
 * Reins agent workspaces, preserving directory structure.
 */
export class MemoryMapper {
  private readonly workspaceManager: AgentWorkspaceManager;

  constructor(workspaceManager: AgentWorkspaceManager) {
    this.workspaceManager = workspaceManager;
  }

  async map(
    workspaceMappings: WorkspaceMapping[],
    options?: MapperOptions,
  ): Promise<MapResult> {
    let converted = 0;
    let skipped = 0;
    const errors: MapError[] = [];
    let processed = 0;

    for (const mapping of workspaceMappings) {
      const sourceExists = await directoryExists(mapping.openClawPath);

      if (!sourceExists) {
        errors.push({
          item: mapping.openClawPath,
          reason: "Source workspace directory does not exist",
        });
        processed += 1;
        options?.onProgress?.(processed, workspaceMappings.length);
        continue;
      }

      const mdFiles = await collectMarkdownFiles(mapping.openClawPath);

      if (mdFiles.length === 0) {
        skipped += 1;
        processed += 1;
        options?.onProgress?.(processed, workspaceMappings.length);
        continue;
      }

      const destBase = this.workspaceManager.resolveWorkspacePath(
        mapping.reinsAgentId,
      );

      for (const absoluteSrc of mdFiles) {
        const relativePath = relative(mapping.openClawPath, absoluteSrc);
        const absoluteDest = join(destBase, relativePath);

        try {
          if (!options?.dryRun) {
            const destDir = join(absoluteDest, "..");
            await mkdir(destDir, { recursive: true });

            const content = await Bun.file(absoluteSrc).arrayBuffer();
            await Bun.write(absoluteDest, content);
          }

          converted += 1;
        } catch (error) {
          errors.push({
            item: relativePath,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }

      processed += 1;
      options?.onProgress?.(processed, workspaceMappings.length);
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

async function collectMarkdownFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      const nested = await collectMarkdownFiles(fullPath);
      results.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(fullPath);
    }
  }

  return results;
}
