import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import { Glob } from "bun";

import { GREP_DEFINITION } from "../builtins";
import { validatePath } from "./sandbox";
import type { SystemToolArgs, SystemToolDefinition, SystemToolResult } from "./types";
import { SystemToolExecutionError } from "./types";

const DEFAULT_MAX_RESULTS = 1000;
const MAX_LINE_LENGTH = 2000;

export class GrepTool {
  readonly definition: SystemToolDefinition;

  constructor(private readonly sandboxRoot: string) {
    this.definition = GREP_DEFINITION;
  }

  async execute(args: SystemToolArgs): Promise<SystemToolResult> {
    const pattern = args["pattern"];
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
      throw SystemToolExecutionError.validation(
        "pattern is required and must be a non-empty string",
        { received: typeof pattern === "string" ? pattern : typeof pattern },
      );
    }

    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch (cause) {
      throw SystemToolExecutionError.validation(
        `Invalid regex pattern: ${pattern}`,
        { pattern, reason: "invalid_regex" },
      );
    }

    let searchRoot = this.sandboxRoot;
    if (typeof args["path"] === "string" && args["path"].trim().length > 0) {
      const pathResult = validatePath(args["path"], this.sandboxRoot);
      if (!pathResult.ok) {
        throw pathResult.error;
      }
      searchRoot = pathResult.value;
    }

    const includePattern = normalizeIncludePattern(args["include"]);

    const maxResults = normalizeMaxResults(args["maxResults"]);

    const filePaths = await collectFiles(searchRoot, includePattern);
    filePaths.sort();

    const results: GrepMatch[] = [];
    let capped = false;

    for (const filePath of filePaths) {
      if (capped) {
        break;
      }

      const absolutePath = resolve(searchRoot, filePath);
      const relativePath = relative(this.sandboxRoot, absolutePath);

      let content: string;
      try {
        content = await readFile(absolutePath, "utf-8");
      } catch {
        continue;
      }

      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          const lineContent = lines[i].length > MAX_LINE_LENGTH
            ? lines[i].slice(0, MAX_LINE_LENGTH)
            : lines[i];

          results.push({
            path: relativePath,
            lineNumber: i + 1,
            content: lineContent,
          });

          if (results.length >= maxResults) {
            capped = true;
            break;
          }
        }
      }
    }

    const output = results.length > 0
      ? results.map((r) => `${r.path}:${r.lineNumber}: ${r.content}`).join("\n")
      : "No matches found.";

    return {
      title: `Grep: ${pattern}`,
      output,
      metadata: {
        truncated: capped,
        lineCount: results.length,
        byteCount: new TextEncoder().encode(output).byteLength,
        pattern,
        matchCount: results.length,
        ...(capped ? { cappedAt: maxResults } : {}),
        searchRoot: relative(this.sandboxRoot, searchRoot) || ".",
      },
    };
  }
}

interface GrepMatch {
  path: string;
  lineNumber: number;
  content: string;
}

async function collectFiles(root: string, pattern: string): Promise<string[]> {
  const files: string[] = [];
  const glob = new Glob(pattern);

  for await (const entry of glob.scan({ cwd: root, dot: false, onlyFiles: true })) {
    files.push(entry);
  }

  return files;
}

function normalizeIncludePattern(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return "**/*";
  }

  const trimmed = value.trim();
  if (trimmed.includes("/") || trimmed.startsWith("**")) {
    return trimmed;
  }

  return `**/${trimmed}`;
}

function normalizeMaxResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_RESULTS;
  }

  const floored = Math.floor(value);
  return floored < 1 ? DEFAULT_MAX_RESULTS : floored;
}
