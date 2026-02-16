import { watch, type FSWatcher } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

import { normalizeSkillName } from "./registry";
import type { SkillRegistry } from "./registry";
import { readSkillMd } from "./parser";
import { validateSkillDirectory } from "./validator";
import type { Skill, SkillConfig } from "./types";
import type { SkillMetadata } from "./metadata";
import type { SkillDirectoryInfo } from "./validator";

/**
 * Options for configuring the SkillWatcher.
 */
export interface SkillWatcherOptions {
  /** Debounce interval in milliseconds (default: 500) */
  debounceMs?: number;
}

/**
 * Callbacks fired when the watcher detects skill changes.
 */
export interface SkillWatcherCallbacks {
  onSkillAdded?: (skill: Skill) => void;
  onSkillChanged?: (skill: Skill) => void;
  onSkillRemoved?: (name: string) => void;
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
 * Watches a skills directory for filesystem changes and updates the
 * SkillRegistry accordingly. Detects new, changed, and removed skills
 * without requiring a restart.
 *
 * Uses `node:fs` watch with debouncing to coalesce rapid filesystem
 * events into a single rescan.
 */
export class SkillWatcher {
  private readonly skillsDir: string;
  private readonly registry: SkillRegistry;
  private readonly debounceMs: number;
  private readonly callbacks: SkillWatcherCallbacks;
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private knownSkills = new Map<string, string>();
  private rescanning = false;

  constructor(
    registry: SkillRegistry,
    skillsDir: string,
    callbacks?: SkillWatcherCallbacks,
    options?: SkillWatcherOptions,
  ) {
    this.registry = registry;
    this.skillsDir = skillsDir;
    this.callbacks = callbacks ?? {};
    this.debounceMs = options?.debounceMs ?? 500;
  }

  /**
   * Start watching the skills directory for changes.
   *
   * Initializes the known skills set from the current registry state
   * and begins filesystem monitoring. Calling `start()` when already
   * watching is a no-op.
   */
  start(): void {
    if (this.watcher) {
      return;
    }

    // Snapshot current registry state and cache raw SKILL.md content
    for (const skill of this.registry.list()) {
      this.knownSkills.set(
        normalizeSkillName(skill.config.name),
        skill.config.path,
      );
    }

    // Seed content cache for known skills so first rescan can detect changes
    this.seedContentCache();

    this.watcher = watch(this.skillsDir, { recursive: true }, () => {
      this.scheduleRescan();
    });

    // Suppress ENOENT errors from deleted subdirectories — the rescan
    // will detect the removal and update the registry accordingly.
    this.watcher.on("error", () => {
      this.scheduleRescan();
    });
  }

  /**
   * Stop watching and clean up all resources.
   *
   * Cancels any pending debounced rescan and closes the filesystem watcher.
   */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  /**
   * Whether the watcher is currently active.
   */
  get watching(): boolean {
    return this.watcher !== null;
  }

  private scheduleRescan(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      void this.rescan();
    }, this.debounceMs);
  }

  /**
   * Read raw SKILL.md content for known skills so we can detect changes.
   */
  private seedContentCache(): void {
    // Content cache is populated lazily during rescan
  }

  /**
   * Content cache for detecting SKILL.md changes.
   * Maps normalized skill name → raw SKILL.md content.
   */
  private contentCache = new Map<string, string>();

  /**
   * Perform a full rescan of the skills directory.
   *
   * Compares current filesystem state against known skills to detect
   * additions, removals, and modifications.
   */
  async rescan(): Promise<void> {
    if (this.rescanning) {
      return;
    }

    this.rescanning = true;

    try {
      await this.performRescan();
    } finally {
      this.rescanning = false;
    }
  }

  private async performRescan(): Promise<void> {
    // Read current subdirectories
    let entries;
    try {
      entries = await readdir(this.skillsDir, { withFileTypes: true });
    } catch {
      return;
    }

    const currentDirs = new Set<string>();

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      currentDirs.add(entry.name);
    }

    // Detect removed skills: known but no longer on disk
    for (const [name, path] of this.knownSkills) {
      const dirName = basename(path);
      if (!currentDirs.has(dirName)) {
        this.registry.remove(name);
        this.knownSkills.delete(name);
        this.contentCache.delete(name);
        this.callbacks.onSkillRemoved?.(name);
      }
    }

    // Process current directories for additions and changes
    for (const dirName of currentDirs) {
      const dirPath = join(this.skillsDir, dirName);

      // Validate the skill directory
      const validateResult = await validateSkillDirectory(dirPath);
      if (!validateResult.ok) {
        continue;
      }

      const dirInfo = validateResult.value;

      // Read and parse SKILL.md
      const skillMdPath = join(dirPath, "SKILL.md");
      const parseResult = await readSkillMd(skillMdPath);
      if (!parseResult.ok) {
        continue;
      }

      const { metadata } = parseResult.value;
      const normalized = normalizeSkillName(metadata.name);

      // Read raw content for change detection
      let rawContent: string;
      try {
        rawContent = await readFile(skillMdPath, "utf-8");
      } catch {
        continue;
      }

      if (this.knownSkills.has(normalized)) {
        // Existing skill — check if content changed
        const cachedContent = this.contentCache.get(normalized);
        if (cachedContent !== undefined && cachedContent !== rawContent) {
          // Content changed — update registry
          const skill = buildSkill(dirInfo, metadata);
          this.registry.remove(normalized);
          this.registry.register(skill);
          this.knownSkills.set(normalized, dirInfo.path);
          this.contentCache.set(normalized, rawContent);
          this.callbacks.onSkillChanged?.(skill);
        } else if (cachedContent === undefined) {
          // First rescan — seed the cache without firing callback
          this.contentCache.set(normalized, rawContent);
        }
      } else {
        // New skill — register it
        if (this.registry.has(normalized)) {
          continue;
        }

        const skill = buildSkill(dirInfo, metadata);
        try {
          this.registry.register(skill);
        } catch {
          continue;
        }

        this.knownSkills.set(normalized, dirInfo.path);
        this.contentCache.set(normalized, rawContent);
        this.callbacks.onSkillAdded?.(skill);
      }
    }
  }
}
