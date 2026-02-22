import { homedir } from "node:os";
import { join } from "node:path";

import type { PersonalityConfig } from "../onboarding/types";
import type { Agent } from "./types";

export interface AgentMigrationOptions {
  userName?: string;
  homeDir?: string;
}

/**
 * Creates a default Agent from an existing PersonalityConfig.
 * The default agent ID is "default" and it inherits the personality preset.
 */
export function migratePersonalityToAgent(
  config: PersonalityConfig,
  options: AgentMigrationOptions = {},
): Agent {
  const now = new Date().toISOString();
  const homeDir = options.homeDir ?? homedir();
  const workspacePath = join(homeDir, ".reins", "agents", "default");

  return {
    id: "default",
    name: options.userName ?? "Default Agent",
    role: "General Assistant",
    workspacePath,
    skills: [],
    identityFiles: {
      custom: {},
    },
    personality: config,
    metadata: {
      createdAt: now,
      updatedAt: now,
      source: "default",
    },
  };
}

/**
 * Creates a default Agent for users who have no personality config.
 */
export function createDefaultAgent(options: AgentMigrationOptions = {}): Agent {
  return migratePersonalityToAgent(
    { preset: "balanced" },
    options,
  );
}
