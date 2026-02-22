import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { OpenClawParseError, type OpenClawConfig, type ParsedOpenClawInstall } from "./types";

const OPENCLAW_CONFIG_FILE = "openclaw.json";

const KNOWN_TOP_LEVEL_KEYS = new Set([
  "meta",
  "auth",
  "agents",
  "channels",
  "gateway",
  "browser",
]);

export interface OpenClawParserOptions {
  readFileFn?: (path: string) => Promise<string | null>;
  listDirFn?: (path: string) => Promise<string[]>;
}

export class OpenClawParser {
  private readonly readFileFn: (path: string) => Promise<string | null>;
  private readonly listDirFn: (path: string) => Promise<string[]>;
  private readonly validateEntryTypes: boolean;

  constructor(options?: OpenClawParserOptions) {
    this.readFileFn = options?.readFileFn ?? defaultReadFileFn;
    this.listDirFn = options?.listDirFn ?? defaultListDirFn;
    this.validateEntryTypes = options?.listDirFn === undefined;
  }

  async parse(stateDir: string): Promise<ParsedOpenClawInstall> {
    const configPath = join(stateDir, OPENCLAW_CONFIG_FILE);
    const raw = await this.readFileFn(configPath);

    if (raw === null) {
      throw new OpenClawParseError("openclaw.json not found");
    }

    const parsed = parseConfig(raw);
    const config = buildConfig(parsed);

    const agentDirs = await this.collectDirectoryPaths(join(stateDir, "agents"));
    const workspaceDirs = await this.collectWorkspaceDirs(stateDir);
    const skillDirs = await this.collectDirectoryPaths(join(stateDir, "skills"));
    const sharedReferenceDirs = await this.collectDirectoryPaths(join(stateDir, "shared-references"));
    const credentialFiles = await this.collectCredentialFiles(join(stateDir, "credentials"));

    return {
      config,
      configPath,
      stateDir,
      agentDirs,
      workspaceDirs,
      skillDirs,
      sharedReferenceDirs,
      credentialFiles,
    };
  }

  private async collectWorkspaceDirs(stateDir: string): Promise<string[]> {
    const entries = await this.listDirFn(stateDir);
    const workspaceEntries = entries.filter((entry) => entry.startsWith("workspace"));

    return this.filterDirectoryPaths(stateDir, workspaceEntries);
  }

  private async collectDirectoryPaths(dirPath: string): Promise<string[]> {
    const entries = await this.listDirFn(dirPath);
    return this.filterDirectoryPaths(dirPath, entries);
  }

  private async collectCredentialFiles(credentialsDirPath: string): Promise<string[]> {
    const entries = await this.listDirFn(credentialsDirPath);
    const jsonFiles = entries.filter((entry) => entry.endsWith(".json"));

    if (!this.validateEntryTypes) {
      return jsonFiles.map((file) => join(credentialsDirPath, file));
    }

    const files: string[] = [];
    for (const file of jsonFiles) {
      const absolutePath = join(credentialsDirPath, file);
      if (await isFile(absolutePath)) {
        files.push(absolutePath);
      }
    }

    return files;
  }

  private async filterDirectoryPaths(parentPath: string, entries: string[]): Promise<string[]> {
    if (!this.validateEntryTypes) {
      return entries.map((entry) => join(parentPath, entry));
    }

    const directories: string[] = [];
    for (const entry of entries) {
      const absolutePath = join(parentPath, entry);
      if (await isDirectory(absolutePath)) {
        directories.push(absolutePath);
      }
    }

    return directories;
  }
}

function parseConfig(raw: string): Record<string, unknown> {
  try {
    return parseAsObject(raw);
  } catch (jsonError) {
    try {
      const withoutComments = stripJson5Comments(raw);
      const withoutTrailingCommas = stripTrailingCommas(withoutComments);
      return parseAsObject(withoutTrailingCommas);
    } catch (json5Error) {
      const reason = json5Error instanceof Error ? json5Error.message : String(json5Error);
      throw new OpenClawParseError(`Failed to parse openclaw.json: ${reason}`);
    }
  }
}

function parseAsObject(raw: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("openclaw.json root must be an object");
  }

  return parsed;
}

function buildConfig(parsed: Record<string, unknown>): OpenClawConfig {
  const unknownFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (!KNOWN_TOP_LEVEL_KEYS.has(key)) {
      unknownFields[key] = value;
    }
  }

  const config: OpenClawConfig = {
    unknownFields,
  };

  if (isRecord(parsed.meta)) {
    config.meta = {
      lastTouchedVersion:
        typeof parsed.meta.lastTouchedVersion === "string" ? parsed.meta.lastTouchedVersion : undefined,
      lastTouchedAt: typeof parsed.meta.lastTouchedAt === "string" ? parsed.meta.lastTouchedAt : undefined,
    };
  }

  if (isRecord(parsed.auth)) {
    const authConfig: OpenClawConfig["auth"] = {};

    if (isRecord(parsed.auth.profiles)) {
      authConfig.profiles = parsed.auth.profiles as NonNullable<OpenClawConfig["auth"]>["profiles"];
    }

    config.auth = authConfig;
  }

  if (isRecord(parsed.agents)) {
    const agentsConfig: OpenClawConfig["agents"] = {};

    if (isRecord(parsed.agents.defaults)) {
      agentsConfig.defaults =
        parsed.agents.defaults as NonNullable<OpenClawConfig["agents"]>["defaults"];
    }

    if (isRecord(parsed.agents.named)) {
      agentsConfig.named = parsed.agents.named as NonNullable<OpenClawConfig["agents"]>["named"];
    }

    config.agents = agentsConfig;
  }

  if (isRecord(parsed.channels)) {
    config.channels = parsed.channels as OpenClawConfig["channels"];
  }

  if (isRecord(parsed.gateway)) {
    config.gateway = parsed.gateway as OpenClawConfig["gateway"];
  }

  if (isRecord(parsed.browser)) {
    config.browser = {
      enabled: typeof parsed.browser.enabled === "boolean" ? parsed.browser.enabled : undefined,
      headless: typeof parsed.browser.headless === "boolean" ? parsed.browser.headless : undefined,
      defaultProfile:
        typeof parsed.browser.defaultProfile === "string" ? parsed.browser.defaultProfile : undefined,
    };
  }

  return config;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripJson5Comments(value: string): string {
  let result = "";
  let inString = false;
  let stringQuote = "";
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }

    if (inString) {
      result += char;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === stringQuote) {
        inString = false;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      result += char;
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }

    result += char;
  }

  return result;
}

function stripTrailingCommas(value: string): string {
  let result = "";
  let inString = false;
  let stringQuote = "";
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (inString) {
      result += char;

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === stringQuote) {
        inString = false;
      }

      continue;
    }

    if (char === '"' || char === "'") {
      inString = true;
      stringQuote = char;
      result += char;
      continue;
    }

    if (char === ",") {
      const next = nextNonWhitespace(value, index + 1);
      if (next === "}" || next === "]") {
        continue;
      }
    }

    result += char;
  }

  return result;
}

function nextNonWhitespace(value: string, start: number): string | null {
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (!/\s/.test(char)) {
      return char;
    }
  }

  return null;
}

async function defaultReadFileFn(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch {
    return null;
  }
}

async function defaultListDirFn(path: string): Promise<string[]> {
  try {
    return await readdir(path);
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const result = await stat(path);
    return result.isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const result = await stat(path);
    return result.isFile();
  } catch {
    return false;
  }
}
