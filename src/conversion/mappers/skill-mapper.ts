import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import type { OpenClawSkillConfig } from "../types";
import type { MapError, MapperOptions, MapResult } from "./types";

/**
 * Shape of a plugin stub entry written by SkillMapper.
 * These are metadata-only — no code execution.
 */
export interface PluginStubEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  source: "openclaw-import";
  enabled: false;
  metadata: {
    originalAuthor?: string;
    originalEntryPoint?: string;
  };
}

export interface SkillMapperOptions {
  outputPath?: string;
}

/**
 * Filesystem abstraction for testability.
 */
export interface SkillMapperFileOps {
  readJson(path: string): Promise<unknown>;
  writeJson(path: string, data: unknown): Promise<void>;
  exists(path: string): Promise<boolean>;
}

const defaultFileOps: SkillMapperFileOps = {
  async readJson(path: string): Promise<unknown> {
    const file = Bun.file(path);
    const text = await file.text();
    return JSON.parse(text);
  },
  async writeJson(path: string, data: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify(data, null, 2));
  },
  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists();
  },
};

function defaultOutputPath(): string {
  return join(homedir(), ".reins", "plugins-imported.json");
}

/**
 * Maps OpenClaw custom skills to Reins plugin stub entries.
 *
 * Skills are registered as available but not executable — code migration
 * is out of scope. Each stub records the original skill metadata and is
 * disabled by default.
 */
export class SkillMapper {
  private readonly outputPath: string;
  private readonly fileOps: SkillMapperFileOps;

  constructor(options?: SkillMapperOptions, fileOps?: SkillMapperFileOps) {
    this.outputPath = options?.outputPath ?? defaultOutputPath();
    this.fileOps = fileOps ?? defaultFileOps;
  }

  async map(
    skills: OpenClawSkillConfig[],
    options?: MapperOptions,
  ): Promise<MapResult> {
    const total = skills.length;
    const errors: MapError[] = [];
    let converted = 0;
    let skipped = 0;

    const existingStubs = await this.loadExistingStubs();
    const existingIds = new Set(existingStubs.map((s) => s.id));
    const newStubs: PluginStubEntry[] = [];

    for (let i = 0; i < skills.length; i++) {
      const skill = skills[i];

      if (!skill.name || skill.name.trim().length === 0) {
        errors.push({ item: "(unnamed)", reason: "Skill has no name" });
        skipped++;
        options?.onProgress?.(i + 1, total);
        continue;
      }

      const stubId = `openclaw-${skill.name}`;

      if (existingIds.has(stubId)) {
        skipped++;
        options?.onProgress?.(i + 1, total);
        continue;
      }

      if (options?.dryRun) {
        converted++;
        options?.onProgress?.(i + 1, total);
        continue;
      }

      const stub = this.createStub(skill);
      newStubs.push(stub);
      existingIds.add(stubId);
      converted++;
      options?.onProgress?.(i + 1, total);
    }

    if (newStubs.length > 0) {
      const merged = [...existingStubs, ...newStubs];
      await this.fileOps.writeJson(this.outputPath, merged);
    }

    return { converted, skipped, errors };
  }

  private createStub(skill: OpenClawSkillConfig): PluginStubEntry {
    const version = typeof skill.version === "string"
      ? skill.version
      : "0.0.0";
    const author = typeof skill.author === "string"
      ? skill.author
      : undefined;

    return {
      id: `openclaw-${skill.name}`,
      name: skill.name,
      description: skill.description ?? "",
      version,
      source: "openclaw-import",
      enabled: false,
      metadata: {
        originalAuthor: author,
        originalEntryPoint: skill.entryPoint,
      },
    };
  }

  private async loadExistingStubs(): Promise<PluginStubEntry[]> {
    const fileExists = await this.fileOps.exists(this.outputPath);
    if (!fileExists) {
      return [];
    }

    try {
      const data = await this.fileOps.readJson(this.outputPath);
      if (Array.isArray(data)) {
        return data as PluginStubEntry[];
      }
      return [];
    } catch {
      return [];
    }
  }
}
