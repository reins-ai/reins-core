import { ReinsError } from "../errors";

/**
 * Platform identifier for OpenClaw detection.
 */
export type OpenClawPlatform = "macos" | "linux" | "windows" | "wsl2";

/**
 * Result of attempting to detect an OpenClaw installation.
 */
export interface DetectionResult {
  found: boolean;
  path: string;
  version?: string;
  platform: OpenClawPlatform;
}

export class OpenClawParseError extends ReinsError {
  constructor(message: string, cause?: Error) {
    super(message, "OPENCLAW_PARSE_ERROR", cause);
    this.name = "OpenClawParseError";
  }
}

// --- OpenClaw Config Types ---

export interface OpenClawAuthProfile {
  provider: string;
  mode: "api_key" | "oauth" | "token";
  key?: string;
  token?: string;
}

export interface OpenClawAgentDefaults {
  model?: {
    primary?: string;
  };
  workspace?: string;
  maxConcurrent?: number;
}

export interface OpenClawAgentConfig {
  id: string;
  workspacePath?: string;
  modelOverride?: string;
  identityFiles?: Record<string, string>;
  skills?: string[];
}

export interface OpenClawChannelConfig {
  type: "telegram" | "discord" | string;
  token?: string;
  chatId?: string;
  guildId?: string;
  [key: string]: unknown;
}

export interface OpenClawSkillConfig {
  name: string;
  description?: string;
  entryPoint?: string;
  [key: string]: unknown;
}

/**
 * Fully typed representation of an openclaw.json config file.
 * Unknown fields are collected in `unknownFields` for import log.
 */
export interface OpenClawConfig {
  meta?: {
    lastTouchedVersion?: string;
    lastTouchedAt?: string;
  };
  auth?: {
    profiles?: Record<string, OpenClawAuthProfile>;
  };
  agents?: {
    defaults?: OpenClawAgentDefaults;
    named?: Record<string, Partial<OpenClawAgentConfig>>;
  };
  channels?: Record<string, OpenClawChannelConfig>;
  gateway?: {
    port?: number;
    authMode?: string;
    authToken?: string;
    [key: string]: unknown;
  };
  browser?: {
    enabled?: boolean;
    headless?: boolean;
    defaultProfile?: string;
  };
  unknownFields: Record<string, unknown>;
}

/**
 * Tool-level configuration from an OpenClaw install (search providers, etc.).
 */
export interface OpenClawToolConfig {
  search?: {
    provider?: string;
    apiKey?: string;
    settings?: Record<string, unknown>;
  };
}

/**
 * Result of parsing an OpenClaw config, including discovered subdirectory paths.
 */
export interface ParsedOpenClawInstall {
  config: OpenClawConfig;
  configPath: string;
  stateDir: string;
  agentDirs: string[];
  workspaceDirs: string[];
  skillDirs: string[];
  sharedReferenceDirs: string[];
  credentialFiles: string[];
}
