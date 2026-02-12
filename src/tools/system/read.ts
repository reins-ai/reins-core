import { readFile, stat } from "node:fs/promises";

import type { ToolContext, ToolResult } from "../../types";
import { READ_DEFINITION } from "../builtins";
import { validatePath } from "./sandbox";
import { truncateOutput } from "./truncation";
import type { SystemToolArgs, SystemToolDefinition, SystemToolResult } from "./types";
import { SystemToolExecutionError } from "./types";

const DEFAULT_OFFSET = 1;
const DEFAULT_LIMIT = 2000;

export class ReadTool {
  readonly definition: SystemToolDefinition;

  constructor(private readonly sandboxRoot: string) {
    this.definition = READ_DEFINITION;
  }

  async execute(args: SystemToolArgs, _context: ToolContext): Promise<ToolResult> {
    const path = args["path"];
    if (typeof path !== "string" || path.trim().length === 0) {
      throw SystemToolExecutionError.validation("path is required and must be a non-empty string", {
        received: typeof path === "string" ? path : typeof path,
      });
    }

    const offset = normalizePositiveInt(args["offset"], DEFAULT_OFFSET);
    const limit = normalizePositiveInt(args["limit"], DEFAULT_LIMIT);

    const pathResult = validatePath(path, this.sandboxRoot);
    if (!pathResult.ok) {
      throw pathResult.error;
    }

    const resolvedPath = pathResult.value;

    await assertIsReadableFile(resolvedPath, path);

    const content = await readFile(resolvedPath, "utf-8");
    const allLines = content.length === 0 ? [] : content.split("\n");

    const startIndex = Math.max(0, offset - 1);
    const sliced = allLines.slice(startIndex, startIndex + limit);

    const numbered = sliced.map(
      (line, index) => `${startIndex + index + 1}: ${line}`,
    );
    const joined = numbered.join("\n");

    const truncated = truncateOutput(joined);

    const systemResult: SystemToolResult = {
      title: `Read ${path}`,
      metadata: {
        truncated: truncated.metadata.truncated,
        lineCount: sliced.length,
        byteCount: truncated.metadata.originalBytes,
        totalLines: allLines.length,
        offset,
        limit,
      },
      output: truncated.output,
    };

    return {
      callId: "",
      name: this.definition.name,
      result: systemResult,
    };
  }
}

function normalizePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  const floored = Math.floor(value);
  return floored < 1 ? fallback : floored;
}

async function assertIsReadableFile(
  resolvedPath: string,
  originalPath: string,
): Promise<void> {
  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch (error: unknown) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      throw SystemToolExecutionError.failed(`File not found: ${originalPath}`, {
        cause: nodeError,
        details: { path: originalPath, reason: "file_not_found" },
      });
    }
    if (nodeError.code === "EACCES") {
      throw SystemToolExecutionError.permissionDenied(
        `Permission denied reading file: ${originalPath}`,
        { path: originalPath, reason: "read_permission_denied" },
      );
    }
    throw SystemToolExecutionError.failed(`Failed to read file: ${originalPath}`, {
      cause: nodeError,
      details: { path: originalPath, reason: "stat_failed" },
    });
  }

  if (fileStat.isDirectory()) {
    throw SystemToolExecutionError.failed(
      `Path is a directory, not a file: ${originalPath}`,
      { details: { path: originalPath, reason: "is_directory" } },
    );
  }

  if (!fileStat.isFile()) {
    throw SystemToolExecutionError.failed(
      `Path is not a regular file: ${originalPath}`,
      { details: { path: originalPath, reason: "not_regular_file" } },
    );
  }
}
