import { homedir } from "node:os";
import { join } from "node:path";

import type { ConversionCategory } from "../agents/types";
import type { AgentStore } from "../agents/store";
import type { KeychainProvider } from "../security/keychain-provider";
import type { ConflictStrategy } from "./types";

const BYOK_SERVICE = "reins-byok";

/**
 * Describes a collision between incoming conversion data and existing Reins data.
 */
export interface Conflict {
  category: ConversionCategory;
  itemName: string;
  existingValue: unknown;
  incomingValue: unknown;
  path: string;
}

/**
 * Describes the set of items a conversion intends to write.
 */
export interface ConversionPlan {
  agents?: Array<{ name: string; [key: string]: unknown }>;
  providerKeys?: Array<{ provider: string; [key: string]: unknown }>;
  channels?: Array<{ name: string; type: string; [key: string]: unknown }>;
}

/**
 * Injectable file operations for reading channels data without direct filesystem access.
 */
export interface ConflictDetectorFileOps {
  readChannelsFile(path: string): Promise<Array<{ name: string; [key: string]: unknown }>>;
}

export interface ConflictDetectorOptions {
  agentStore: AgentStore;
  keychainProvider: KeychainProvider;
  channelsFilePath?: string;
  fileOps?: ConflictDetectorFileOps;
}

function defaultChannelsFilePath(): string {
  return join(homedir(), ".reins", "channels.json");
}

async function defaultReadChannelsFile(
  path: string,
): Promise<Array<{ name: string; [key: string]: unknown }>> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return [];
  }

  try {
    const parsed = await file.json();
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed as Array<{ name: string; [key: string]: unknown }>;
  } catch {
    return [];
  }
}

const defaultFileOps: ConflictDetectorFileOps = {
  readChannelsFile: defaultReadChannelsFile,
};

export interface ResolutionRecord {
  conflict: Conflict;
  strategy: ConflictStrategy;
  outcome: "applied" | "skipped" | "merged";
  mergedValue?: unknown;
}

/**
 * Applies a conflict resolution strategy (overwrite, merge, skip) to detected
 * conflicts and records the outcome for the conversion report.
 */
export class ConflictResolver {
  resolve(conflict: Conflict, strategy: ConflictStrategy): ResolutionRecord {
    switch (strategy) {
      case "overwrite":
        return {
          conflict,
          strategy,
          outcome: "applied",
          mergedValue: conflict.incomingValue,
        };

      case "skip":
        return {
          conflict,
          strategy,
          outcome: "skipped",
          mergedValue: conflict.existingValue,
        };

      case "merge":
        return this.mergeConflict(conflict);
    }
  }

  resolveAll(
    conflicts: Conflict[],
    strategy: ConflictStrategy,
  ): ResolutionRecord[] {
    return conflicts.map((c) => this.resolve(c, strategy));
  }

  async resolveWithCallback(
    conflicts: Conflict[],
    onConflict: (conflict: Conflict) => Promise<ConflictStrategy>,
  ): Promise<ResolutionRecord[]> {
    const records: ResolutionRecord[] = [];
    for (const conflict of conflicts) {
      const strategy = await onConflict(conflict);
      records.push(this.resolve(conflict, strategy));
    }
    return records;
  }

  private mergeConflict(conflict: Conflict): ResolutionRecord {
    const { existingValue, incomingValue } = conflict;

    if (Array.isArray(existingValue) && Array.isArray(incomingValue)) {
      const merged = [...new Set([...existingValue, ...incomingValue])];
      return {
        conflict,
        strategy: "merge",
        outcome: "merged",
        mergedValue: merged,
      };
    }

    if (
      this.isPlainObject(existingValue) &&
      this.isPlainObject(incomingValue)
    ) {
      const merged = { ...existingValue, ...incomingValue };
      return {
        conflict,
        strategy: "merge",
        outcome: "merged",
        mergedValue: merged,
      };
    }

    // Scalar or incompatible types: fall back to overwrite
    return {
      conflict,
      strategy: "merge",
      outcome: "applied",
      mergedValue: incomingValue,
    };
  }

  private isPlainObject(value: unknown): value is Record<string, unknown> {
    return (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    );
  }
}

/**
 * Detects existing Reins data that would collide with a conversion plan.
 *
 * Checks three categories:
 * - Agents: name collisions against AgentStore
 * - Provider keys: existing BYOK keys in keychain
 * - Channels: name collisions against channels.json
 */
export class ConflictDetector {
  private readonly agentStore: AgentStore;
  private readonly keychainProvider: KeychainProvider;
  private readonly channelsFilePath: string;
  private readonly fileOps: ConflictDetectorFileOps;

  constructor(options: ConflictDetectorOptions) {
    this.agentStore = options.agentStore;
    this.keychainProvider = options.keychainProvider;
    this.channelsFilePath = options.channelsFilePath ?? defaultChannelsFilePath();
    this.fileOps = options.fileOps ?? defaultFileOps;
  }

  async detect(plan: ConversionPlan): Promise<Conflict[]> {
    const conflicts: Conflict[] = [];

    await Promise.all([
      this.detectAgentConflicts(plan, conflicts),
      this.detectProviderKeyConflicts(plan, conflicts),
      this.detectChannelConflicts(plan, conflicts),
    ]);

    return conflicts;
  }

  private async detectAgentConflicts(
    plan: ConversionPlan,
    conflicts: Conflict[],
  ): Promise<void> {
    const planAgents = plan.agents;
    if (!planAgents || planAgents.length === 0) {
      return;
    }

    const listResult = await this.agentStore.list();
    if (!listResult.ok) {
      return;
    }

    const existingNames = new Map<string, unknown>();
    for (const agent of listResult.value) {
      existingNames.set(agent.name.toLowerCase(), agent);
    }

    for (const incoming of planAgents) {
      const normalized = incoming.name.toLowerCase();
      const existing = existingNames.get(normalized);
      if (existing !== undefined) {
        conflicts.push({
          category: "agents",
          itemName: incoming.name,
          existingValue: existing,
          incomingValue: incoming,
          path: "agents",
        });
      }
    }
  }

  private async detectProviderKeyConflicts(
    plan: ConversionPlan,
    conflicts: Conflict[],
  ): Promise<void> {
    const planKeys = plan.providerKeys;
    if (!planKeys || planKeys.length === 0) {
      return;
    }

    for (const incoming of planKeys) {
      const getResult = await this.keychainProvider.get(
        BYOK_SERVICE,
        incoming.provider,
      );

      if (getResult.ok && getResult.value !== null) {
        conflicts.push({
          category: "auth-profiles",
          itemName: incoming.provider,
          existingValue: `[keychain:${BYOK_SERVICE}/${incoming.provider}]`,
          incomingValue: incoming,
          path: `keychain/${BYOK_SERVICE}/${incoming.provider}`,
        });
      }
    }
  }

  private async detectChannelConflicts(
    plan: ConversionPlan,
    conflicts: Conflict[],
  ): Promise<void> {
    const planChannels = plan.channels;
    if (!planChannels || planChannels.length === 0) {
      return;
    }

    const existingChannels = await this.fileOps.readChannelsFile(
      this.channelsFilePath,
    );

    const existingNames = new Map<string, unknown>();
    for (const channel of existingChannels) {
      if (typeof channel.name === "string") {
        existingNames.set(channel.name.toLowerCase(), channel);
      }
    }

    for (const incoming of planChannels) {
      const normalized = incoming.name.toLowerCase();
      const existing = existingNames.get(normalized);
      if (existing !== undefined) {
        conflicts.push({
          category: "channel-credentials",
          itemName: incoming.name,
          existingValue: existing,
          incomingValue: incoming,
          path: this.channelsFilePath,
        });
      }
    }
  }
}
