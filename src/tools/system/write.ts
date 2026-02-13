import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { validatePath } from "./sandbox";
import type { SystemToolArgs, SystemToolResult } from "./types";
import { SystemToolExecutionError } from "./types";

export async function executeWrite(
  args: SystemToolArgs,
  sandboxRoot: string,
): Promise<SystemToolResult> {
  const path = args["path"];
  const content = args["content"];

  if (typeof path !== "string" || path.length === 0) {
    throw SystemToolExecutionError.validation("Missing required argument: path", {
      argument: "path",
    });
  }

  if (typeof content !== "string") {
    throw SystemToolExecutionError.validation("Missing required argument: content", {
      argument: "content",
    });
  }

  const pathResult = validatePath(path, sandboxRoot);
  if (!pathResult.ok) {
    throw pathResult.error;
  }

  const resolvedPath = pathResult.value;
  const parentDir = dirname(resolvedPath);

  try {
    await mkdir(parentDir, { recursive: true });
  } catch (cause) {
    throw SystemToolExecutionError.permissionDenied(
      `Failed to create parent directories for: ${path}`,
      {
        path: resolvedPath,
        reason: "directory_creation_failed",
      },
    );
  }

  try {
    await writeFile(resolvedPath, content, "utf-8");
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (isPermissionError(error)) {
      throw SystemToolExecutionError.permissionDenied(
        `Write permission denied: ${path}`,
        {
          path: resolvedPath,
          reason: "write_permission_denied",
        },
      );
    }

    throw SystemToolExecutionError.failed(`Failed to write file: ${path}`, {
      cause: error,
      details: {
        path: resolvedPath,
        reason: "write_failed",
      },
    });
  }

  const byteCount = new TextEncoder().encode(content).byteLength;

  return {
    title: `Wrote ${byteCount} bytes to ${path}`,
    output: `Successfully wrote ${byteCount} bytes to ${path}`,
    metadata: {
      truncated: false,
      lineCount: countLines(content),
      byteCount,
      path: resolvedPath,
      bytesWritten: byteCount,
    },
  };
}

function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }

  let lines = 1;
  for (const char of content) {
    if (char === "\n") {
      lines += 1;
    }
  }

  return lines;
}

function isPermissionError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM";
}
