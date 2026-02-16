import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { normalizeSkillName } from "./registry";
import type { SkillRegistry } from "./registry";
import { readSkillMd } from "./parser";
import { validateSkillDirectory } from "./validator";
import type { SkillDirectoryInfo } from "./validator";
import type { Skill, SkillConfig } from "./types";
import type { SkillMetadata } from "./metadata";

/**
 * Describes a single skill that failed during discovery.
 */
export interface SkillDiscoveryError {
  /** Path to the skill directory that failed */
  skillDir: string;
  /** Human-readable error description */
  error: string;
}

/**
 * Summary report returned after scanning a skills directory.
 */
export interface DiscoveryReport {
  /** Total subdirectories found in the skills directory */
  discovered: number;
  /** Number of skills successfully registered */
  loaded: number;
  /** Skills that failed validation or parsing */
  errors: SkillDiscoveryError[];
  /** Non-directory entries that were skipped */
  skipped: number;
}

/**
 * Cached content for a discovered skill, available for on-demand loading.
 */
interface SkillContent {
  body: string;
  metadata: SkillMetadata;
  raw: string;
}

/**
 * Build a `Skill` object from validated directory info and parsed metadata.
 */
function buildSkill(dirInfo: SkillDirectoryInfo, metadata: SkillMetadata): Skill {
  const config: SkillConfig = {
    name: metadata.name,
    enabled: true,
    trustLevel: metadata.trustLevel ?? "untrusted",
    path: dirInfo.path,
  };

  return {
    config,
    summary: { name: metadata.name, description: metadata.description },
    hasScripts: dirInfo.hasScripts,
    hasIntegration: dirInfo.hasIntegrationMd,
    scriptFiles: dirInfo.scriptFiles,
    categories: metadata.categories ?? [],
  };
}

/**
 * Scans a skills directory, validates each subdirectory, parses SKILL.md files,
 * and registers valid skills into a `SkillRegistry`.
 *
 * Individual skill errors are collected in the report rather than aborting the
 * entire scan. If the skills directory does not exist, an empty report is
 * returned (not an error).
 */
export class SkillScanner {
  private readonly registry: SkillRegistry;
  private readonly skillsDir: string;
  private readonly contentCache = new Map<string, SkillContent>();

  constructor(registry: SkillRegistry, skillsDir: string) {
    this.registry = registry;
    this.skillsDir = skillsDir;
  }

  /**
   * Scan the skills directory and register all valid skills.
   *
   * Never throws — all errors are captured in the returned report.
   */
  async scan(): Promise<DiscoveryReport> {
    const report: DiscoveryReport = {
      discovered: 0,
      loaded: 0,
      errors: [],
      skipped: 0,
    };

    // Read the top-level skills directory
    let entries;
    try {
      entries = await readdir(this.skillsDir, { withFileTypes: true });
    } catch {
      // Directory doesn't exist or is unreadable — return empty report
      return report;
    }

    for (const entry of entries) {
      // Skip non-directory entries (files, symlinks, etc.)
      if (!entry.isDirectory()) {
        report.skipped++;
        continue;
      }

      report.discovered++;
      const dirPath = join(this.skillsDir, entry.name);

      // Validate directory structure
      const validateResult = await validateSkillDirectory(dirPath);
      if (!validateResult.ok) {
        report.errors.push({
          skillDir: dirPath,
          error: validateResult.error.message,
        });
        continue;
      }

      const dirInfo = validateResult.value;

      // Parse SKILL.md
      const parseResult = await readSkillMd(join(dirPath, "SKILL.md"));
      if (!parseResult.ok) {
        report.errors.push({
          skillDir: dirPath,
          error: parseResult.error.message,
        });
        continue;
      }

      const { metadata, body, raw } = parseResult.value;

      // Check for duplicate names already in the registry
      const normalized = normalizeSkillName(metadata.name);
      if (this.registry.has(normalized)) {
        report.errors.push({
          skillDir: dirPath,
          error: `Skill name "${metadata.name}" is already registered`,
        });
        continue;
      }

      // Build and register the skill
      const skill = buildSkill(dirInfo, metadata);

      try {
        this.registry.register(skill);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        report.errors.push({
          skillDir: dirPath,
          error: message,
        });
        continue;
      }

      // Cache content for on-demand loading
      this.contentCache.set(normalized, { body, metadata, raw });
      report.loaded++;
    }

    return report;
  }

  /**
   * Load full skill content on-demand.
   *
   * Returns the cached body, metadata, and raw content for a registered skill,
   * or `undefined` if the skill was not discovered by this scanner.
   */
  loadSkill(name: string): SkillContent | undefined {
    return this.contentCache.get(normalizeSkillName(name));
  }
}
