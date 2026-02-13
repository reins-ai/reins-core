import { readFile, writeFile } from "node:fs/promises";

import { validatePath } from "./sandbox";
import type { SystemToolArgs, SystemToolResult } from "./types";
import { SystemToolExecutionError } from "./types";

export async function executeEdit(
  args: SystemToolArgs,
  sandboxRoot: string,
): Promise<SystemToolResult> {
  const path = args["path"];
  const oldString = args["oldString"];
  const newString = args["newString"];

  if (typeof path !== "string" || path.length === 0) {
    throw SystemToolExecutionError.validation("Missing required argument: path", {
      argument: "path",
    });
  }

  if (typeof oldString !== "string") {
    throw SystemToolExecutionError.validation("Missing required argument: oldString", {
      argument: "oldString",
    });
  }

  if (typeof newString !== "string") {
    throw SystemToolExecutionError.validation("Missing required argument: newString", {
      argument: "newString",
    });
  }

  const pathResult = validatePath(path, sandboxRoot);
  if (!pathResult.ok) {
    throw pathResult.error;
  }

  const resolvedPath = pathResult.value;

  let fileContent: string;
  try {
    fileContent = await readFile(resolvedPath, "utf-8");
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    if (isNotFoundError(error)) {
      throw SystemToolExecutionError.failed(`File not found: ${path}`, {
        cause: error,
        details: {
          path: resolvedPath,
          reason: "file_not_found",
        },
      });
    }

    throw SystemToolExecutionError.failed(`Failed to read file: ${path}`, {
      cause: error,
      details: {
        path: resolvedPath,
        reason: "read_failed",
      },
    });
  }

  const matchCount = countOccurrences(fileContent, oldString);

  if (matchCount === 0) {
    throw SystemToolExecutionError.failed("String not found in file", {
      details: {
        path: resolvedPath,
        reason: "string_not_found",
        searchString: oldString.length > 200 ? oldString.slice(0, 200) + "..." : oldString,
      },
    });
  }

  if (matchCount > 1) {
    throw SystemToolExecutionError.validation(
      `Ambiguous match: found ${matchCount} occurrences of the search string`,
      {
        path: resolvedPath,
        reason: "ambiguous_match",
        count: matchCount,
        searchString: oldString.length > 200 ? oldString.slice(0, 200) + "..." : oldString,
      },
    );
  }

  const matchIndex = fileContent.indexOf(oldString);
  const updatedContent = fileContent.slice(0, matchIndex) + newString +
    fileContent.slice(matchIndex + oldString.length);

  try {
    await writeFile(resolvedPath, updatedContent, "utf-8");
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    throw SystemToolExecutionError.failed(`Failed to write edited file: ${path}`, {
      cause: error,
      details: {
        path: resolvedPath,
        reason: "write_failed",
      },
    });
  }

  const lineNumber = getLineNumber(fileContent, matchIndex);
  const diffOutput = generateDiff(fileContent, oldString, newString, matchIndex);
  const byteCount = new TextEncoder().encode(updatedContent).byteLength;

  return {
    title: `Edited ${path} at line ${lineNumber}`,
    output: diffOutput,
    metadata: {
      truncated: false,
      lineCount: countLines(updatedContent),
      byteCount,
      path: resolvedPath,
      lineNumber,
      replacedLength: oldString.length,
      insertedLength: newString.length,
    },
  };
}

function countOccurrences(content: string, search: string): number {
  if (search.length === 0) {
    return 0;
  }

  let count = 0;
  let position = 0;

  while (position <= content.length - search.length) {
    const index = content.indexOf(search, position);
    if (index === -1) {
      break;
    }

    count += 1;
    position = index + 1;
  }

  return count;
}

function getLineNumber(content: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex; i++) {
    if (content[i] === "\n") {
      line += 1;
    }
  }

  return line;
}

function generateDiff(
  content: string,
  oldString: string,
  newString: string,
  matchIndex: number,
): string {
  const contextLines = 3;
  const lines = content.split("\n");

  const startLine = getLineNumber(content, matchIndex);
  const oldEndLine = getLineNumber(content, matchIndex + oldString.length - 1);

  const contextStart = Math.max(0, startLine - 1 - contextLines);
  const contextEnd = Math.min(lines.length - 1, oldEndLine - 1 + contextLines);

  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");

  const parts: string[] = [];

  parts.push(`@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`);

  for (let i = contextStart; i < startLine - 1; i++) {
    parts.push(` ${lines[i]}`);
  }

  for (const line of oldLines) {
    parts.push(`-${line}`);
  }

  for (const line of newLines) {
    parts.push(`+${line}`);
  }

  for (let i = oldEndLine; i <= contextEnd; i++) {
    parts.push(` ${lines[i]}`);
  }

  return parts.join("\n");
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

function isNotFoundError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
