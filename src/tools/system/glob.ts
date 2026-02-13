import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

import { Glob } from "bun";

import { GLOB_DEFINITION } from "../builtins";
import { validatePath } from "./sandbox";
import type { SystemToolArgs, SystemToolDefinition, SystemToolResult } from "./types";
import { SystemToolExecutionError } from "./types";

const DEFAULT_MAX_RESULTS = 1000;

export class GlobTool {
  readonly definition: SystemToolDefinition;

  constructor(private readonly sandboxRoot: string) {
    this.definition = GLOB_DEFINITION;
  }

  async execute(args: SystemToolArgs): Promise<SystemToolResult> {
    const pattern = args["pattern"];
    if (typeof pattern !== "string" || pattern.trim().length === 0) {
      throw SystemToolExecutionError.validation(
        "pattern is required and must be a non-empty string",
        { received: typeof pattern === "string" ? pattern : typeof pattern },
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

    const ignorePatterns = await loadGitignorePatterns(this.sandboxRoot);

    const matches: string[] = [];
    const glob = new Glob(pattern);

    for await (const entry of glob.scan({ cwd: searchRoot, dot: false })) {
      const absolutePath = resolve(searchRoot, entry);
      const relativePath = relative(this.sandboxRoot, absolutePath);

      if (isIgnored(relativePath, ignorePatterns)) {
        continue;
      }

      matches.push(relativePath);

      if (matches.length >= DEFAULT_MAX_RESULTS) {
        break;
      }
    }

    matches.sort();

    const truncated = matches.length >= DEFAULT_MAX_RESULTS;
    const output = matches.length > 0
      ? matches.join("\n")
      : "No files matched the pattern.";

    return {
      title: `Glob: ${pattern}`,
      output,
      metadata: {
        truncated,
        lineCount: matches.length,
        byteCount: new TextEncoder().encode(output).byteLength,
        pattern,
        matchCount: matches.length,
        searchRoot: relative(this.sandboxRoot, searchRoot) || ".",
      },
    };
  }
}

interface IgnoreRule {
  pattern: string;
  negated: boolean;
  directoryOnly: boolean;
}

async function loadGitignorePatterns(root: string): Promise<IgnoreRule[]> {
  const gitignorePath = join(root, ".gitignore");
  let content: string;
  try {
    content = await readFile(gitignorePath, "utf-8");
  } catch {
    return [];
  }

  const rules: IgnoreRule[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    let pattern = line;
    let negated = false;
    let directoryOnly = false;

    if (pattern.startsWith("!")) {
      negated = true;
      pattern = pattern.slice(1);
    }

    if (pattern.endsWith("/")) {
      directoryOnly = true;
      pattern = pattern.slice(0, -1);
    }

    if (pattern.startsWith("/")) {
      pattern = pattern.slice(1);
    }

    if (pattern.length > 0) {
      rules.push({ pattern, negated, directoryOnly });
    }
  }

  return rules;
}

function isIgnored(filePath: string, rules: IgnoreRule[]): boolean {
  if (rules.length === 0) {
    return false;
  }

  let ignored = false;
  const segments = filePath.split("/");

  for (const rule of rules) {
    if (rule.directoryOnly) {
      continue;
    }

    const matches = matchesIgnorePattern(filePath, segments, rule.pattern);
    if (matches) {
      ignored = !rule.negated;
    }
  }

  return ignored;
}

function matchesIgnorePattern(
  filePath: string,
  segments: string[],
  pattern: string,
): boolean {
  if (pattern.includes("/")) {
    return globMatch(filePath, pattern);
  }

  for (const segment of segments) {
    if (globMatch(segment, pattern)) {
      return true;
    }
  }

  return false;
}

function globMatch(text: string, pattern: string): boolean {
  let ti = 0;
  let pi = 0;
  let starTi = -1;
  let starPi = -1;

  while (ti < text.length) {
    if (pi < pattern.length && (pattern[pi] === text[ti] || pattern[pi] === "?")) {
      ti++;
      pi++;
    } else if (pi < pattern.length && pattern[pi] === "*") {
      starTi = ti;
      starPi = pi;
      pi++;
    } else if (starPi >= 0) {
      ti = starTi + 1;
      starTi = ti;
      pi = starPi + 1;
    } else {
      return false;
    }
  }

  while (pi < pattern.length && pattern[pi] === "*") {
    pi++;
  }

  return pi === pattern.length;
}
