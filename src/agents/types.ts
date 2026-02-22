import type { PersonalityConfig } from "../onboarding/types";

/**
 * Defines a per-agent model selection that overrides global provider/model defaults.
 */
export interface ModelOverride {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
}

/**
 * Defines the canonical identity file paths associated with an agent workspace.
 */
export interface AgentIdentityFiles {
  soul?: string;
  memory?: string;
  identity?: string;
  custom: Record<string, string>;
}

/**
 * Enumerates conversion categories that can be selectively imported from OpenClaw.
 */
export type ConversionCategory =
  | "agents"
  | "workspace-memory"
  | "auth-profiles"
  | "channel-credentials"
  | "skills"
  | "conversations"
  | "shared-references"
  | "tool-config"
  | "gateway-config";

/**
 * Defines the normalized Reins agent shape used at runtime and for persistence.
 */
export interface Agent {
  id: string;
  name: string;
  role: string;
  workspacePath: string;
  modelOverride?: ModelOverride;
  skills: string[];
  identityFiles: AgentIdentityFiles;
  personality?: PersonalityConfig;
  metadata: {
    createdAt: string;
    updatedAt: string;
    source?: string;
  };
}

/**
 * Defines the on-disk JSON schema for serialized agent configuration entries.
 */
export type AgentConfig = Agent;

/**
 * Lists every conversion category in a stable order for UI and API checklists.
 */
export const ALL_CONVERSION_CATEGORIES = [
  "agents",
  "workspace-memory",
  "auth-profiles",
  "channel-credentials",
  "skills",
  "conversations",
  "shared-references",
  "tool-config",
  "gateway-config",
] as const satisfies readonly ConversionCategory[];
