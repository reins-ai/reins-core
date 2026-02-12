import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../../types";
import { LS_DEFINITION } from "../builtins";
import { validatePath } from "./sandbox";
import type {
  SystemToolArgs,
  SystemToolDefinition,
  SystemToolResult,
} from "./types";
import { SystemToolExecutionError } from "./types";

type LsToolDefinition = SystemToolDefinition & ToolDefinition;

interface LsEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modified: string;
}

export class LsTool implements Tool {
  readonly definition: LsToolDefinition;

  constructor(private readonly sandboxRoot: string) {
    this.definition = {
      ...LS_DEFINITION,
      parameters: LS_DEFINITION.input_schema,
    };
  }

  async execute(args: SystemToolArgs, _context: ToolContext): Promise<ToolResult> {
    const targetDir = await this.resolveTargetDirectory(args);
    const entries = await this.readEntries(targetDir);
    const sorted = sortEntries(entries);
    const output = formatEntries(sorted);

    const displayPath = relative(this.sandboxRoot, targetDir) || ".";

    const systemResult: SystemToolResult = {
      title: `Listed ${sorted.length} entries in ${displayPath}`,
      output,
      metadata: {
        truncated: false,
        lineCount: sorted.length,
        byteCount: new TextEncoder().encode(output).byteLength,
        entryCount: sorted.length,
        directories: sorted.filter((e) => e.type === "directory").length,
        files: sorted.filter((e) => e.type !== "directory").length,
        path: displayPath,
      },
    };

    return {
      callId: "system-ls",
      name: this.definition.name,
      result: systemResult,
    };
  }

  private async resolveTargetDirectory(args: SystemToolArgs): Promise<string> {
    const path = args["path"];

    if (path === undefined || path === null) {
      return this.sandboxRoot;
    }

    if (typeof path !== "string" || path.trim().length === 0) {
      return this.sandboxRoot;
    }

    const pathResult = validatePath(path, this.sandboxRoot);
    if (!pathResult.ok) {
      throw pathResult.error;
    }

    const resolvedPath = pathResult.value;
    await assertIsDirectory(resolvedPath, path);

    return resolvedPath;
  }

  private async readEntries(dirPath: string): Promise<LsEntry[]> {
    let names: string[];
    try {
      names = await readdir(dirPath);
    } catch (error: unknown) {
      const nodeError = error as NodeJS.ErrnoException;
      if (nodeError.code === "EACCES" || nodeError.code === "EPERM") {
        throw SystemToolExecutionError.permissionDenied(
          `Permission denied reading directory: ${dirPath}`,
          { path: dirPath, reason: "read_permission_denied" },
        );
      }
      throw SystemToolExecutionError.failed(`Failed to read directory: ${dirPath}`, {
        cause: nodeError,
        details: { path: dirPath, reason: "readdir_failed" },
      });
    }

    const entries: LsEntry[] = [];

    for (const name of names) {
      const fullPath = join(dirPath, name);
      try {
        const fileStat = await stat(fullPath);
        entries.push({
          name,
          type: classifyType(fileStat),
          size: fileStat.isDirectory() ? 0 : fileStat.size,
          modified: fileStat.mtime.toISOString(),
        });
      } catch {
        entries.push({
          name,
          type: "other",
          size: 0,
          modified: new Date(0).toISOString(),
        });
      }
    }

    return entries;
  }
}

function classifyType(fileStat: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): LsEntry["type"] {
  if (fileStat.isDirectory()) {
    return "directory";
  }
  if (fileStat.isSymbolicLink()) {
    return "symlink";
  }
  if (fileStat.isFile()) {
    return "file";
  }
  return "other";
}

function sortEntries(entries: LsEntry[]): LsEntry[] {
  return [...entries].sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") {
      return -1;
    }
    if (a.type !== "directory" && b.type === "directory") {
      return 1;
    }
    return a.name.localeCompare(b.name);
  });
}

function formatEntries(entries: LsEntry[]): string {
  if (entries.length === 0) {
    return "Empty directory.";
  }

  const lines = entries.map((entry) => {
    const typeIndicator = entry.type === "directory" ? "d" : entry.type === "symlink" ? "l" : "-";
    const displayName = entry.type === "directory" ? `${entry.name}/` : entry.name;
    const sizeStr = entry.type === "directory" ? "-" : String(entry.size);
    return `${typeIndicator}  ${displayName}\t${sizeStr}\t${entry.modified}`;
  });

  return lines.join("\n");
}

async function assertIsDirectory(resolvedPath: string, originalPath: string): Promise<void> {
  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw SystemToolExecutionError.failed(`Path not found: ${originalPath}`, {
        cause: nodeError,
        details: { path: originalPath, reason: "path_not_found" },
      });
    }
    if (nodeError.code === "EACCES" || nodeError.code === "EPERM") {
      throw SystemToolExecutionError.permissionDenied(
        `Permission denied: ${originalPath}`,
        { path: originalPath, reason: "stat_permission_denied" },
      );
    }
    throw SystemToolExecutionError.failed(`Failed to access path: ${originalPath}`, {
      cause: nodeError,
      details: { path: originalPath, reason: "stat_failed" },
    });
  }

  if (!fileStat.isDirectory()) {
    throw SystemToolExecutionError.validation(
      `Path is not a directory: ${originalPath}`,
      { path: originalPath, reason: "not_a_directory" },
    );
  }
}
