import { join } from "node:path";

import type { AgentStore } from "../../agents/store";
import type { Agent, AgentIdentityFiles } from "../../agents/types";
import type { IdentityFileManager } from "../../agents/identity";
import type { AgentWorkspaceManager } from "../../agents/workspace";
import type { OpenClawAgentConfig } from "../types";
import type { MapError, MapperOptions, MapResult } from "./types";

const KNOWN_IDENTITY_FILES = ["soul", "memory", "identity"] as const;

export interface AgentMapperDeps {
  agentStore: AgentStore;
  workspaceManager: AgentWorkspaceManager;
  identityManager: IdentityFileManager;
}

export interface AgentMapperFileCopier {
  copy(srcPath: string, destPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const defaultFileCopier: AgentMapperFileCopier = {
  async copy(srcPath: string, destPath: string): Promise<void> {
    const content = await Bun.file(srcPath).text();
    await Bun.write(destPath, content);
  },
  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  },
};

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class AgentMapper {
  private readonly deps: AgentMapperDeps;
  private readonly fileCopier: AgentMapperFileCopier;

  constructor(deps: AgentMapperDeps, fileCopier?: AgentMapperFileCopier) {
    this.deps = deps;
    this.fileCopier = fileCopier ?? defaultFileCopier;
  }

  async map(
    openClawAgents: Record<string, Partial<OpenClawAgentConfig>>,
    options?: MapperOptions,
  ): Promise<MapResult> {
    const entries = Object.entries(openClawAgents);
    const total = entries.length;
    const errors: MapError[] = [];
    let converted = 0;
    let skipped = 0;

    for (let i = 0; i < entries.length; i++) {
      const [name, agentConfig] = entries[i];

      if (!name || name.trim().length === 0) {
        errors.push({ item: "(unnamed)", reason: "Agent has no name" });
        skipped++;
        options?.onProgress?.(i + 1, total);
        continue;
      }

      if (options?.dryRun) {
        converted++;
        options?.onProgress?.(i + 1, total);
        continue;
      }

      try {
        await this.convertAgent(name, agentConfig);
        converted++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        errors.push({ item: name, reason });
        skipped++;
      }

      options?.onProgress?.(i + 1, total);
    }

    return { converted, skipped, errors };
  }

  private async convertAgent(
    name: string,
    config: Partial<OpenClawAgentConfig>,
  ): Promise<void> {
    const agentId = config.id ?? slugify(name);
    const workspacePath = await this.deps.workspaceManager.createWorkspace(agentId);

    const identityFiles = await this.copyIdentityFiles(
      config.identityFiles,
      workspacePath,
    );

    const now = new Date().toISOString();
    const agent: Agent = {
      id: agentId,
      name,
      role: this.extractRole(config),
      workspacePath,
      skills: config.skills ?? [],
      identityFiles,
      metadata: {
        createdAt: now,
        updatedAt: now,
        source: "openclaw-import",
      },
    };

    if (config.modelOverride) {
      agent.modelOverride = this.parseModelOverride(config.modelOverride);
    }

    const result = await this.deps.agentStore.create(agent);
    if (!result.ok) {
      throw result.error;
    }
  }

  private extractRole(_config: Partial<OpenClawAgentConfig>): string {
    // OpenClawAgentConfig doesn't have a role field — derive from id or default
    return "assistant";
  }

  private parseModelOverride(
    modelString: string,
  ): { provider: string; model: string } {
    // OpenClaw stores model override as "provider/model" or just "model"
    const slashIndex = modelString.indexOf("/");
    if (slashIndex > 0) {
      return {
        provider: modelString.slice(0, slashIndex),
        model: modelString.slice(slashIndex + 1),
      };
    }
    return { provider: "default", model: modelString };
  }

  private async copyIdentityFiles(
    sourceFiles: Record<string, string> | undefined,
    workspacePath: string,
  ): Promise<AgentIdentityFiles> {
    const identityFiles: AgentIdentityFiles = { custom: {} };

    if (!sourceFiles) {
      return identityFiles;
    }

    for (const [key, srcPath] of Object.entries(sourceFiles)) {
      if (!srcPath) continue;

      const fileExists = await this.fileCopier.exists(srcPath);
      if (!fileExists) continue;

      const knownKey = KNOWN_IDENTITY_FILES.find((k) => k === key);
      if (knownKey) {
        const destFileName = this.identityFileName(knownKey);
        const destPath = join(workspacePath, destFileName);
        await this.fileCopier.copy(srcPath, destPath);
        identityFiles[knownKey] = destPath;
      } else {
        const destPath = join(workspacePath, key);
        await this.fileCopier.copy(srcPath, destPath);
        identityFiles.custom[key] = destPath;
      }
    }

    return identityFiles;
  }

  private identityFileName(key: "soul" | "memory" | "identity"): string {
    switch (key) {
      case "soul": return "SOUL.md";
      case "memory": return "MEMORY.md";
      case "identity": return "IDENTITY.md";
    }
  }
}
