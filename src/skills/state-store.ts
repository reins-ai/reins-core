import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createLogger } from "../logger";

const log = createLogger("skills:state-store");

/**
 * Persisted state for a single skill.
 */
export interface PersistedSkillState {
  enabled: boolean;
}

/**
 * Full persisted state map: skill name → state.
 */
export type SkillStateData = Record<string, PersistedSkillState>;

/**
 * Interface for persisting skill enable/disable state across sessions.
 */
export interface SkillStateStore {
  /** Get the enabled state for a skill. Returns undefined if no persisted state. */
  getEnabled(skillName: string): boolean | undefined;

  /** Set the enabled state for a skill. */
  setEnabled(skillName: string, enabled: boolean): void;

  /** Load all persisted state from storage. */
  load(): Promise<void>;

  /** Save all state to storage. */
  save(): Promise<void>;
}

function isMissingFileError(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    (value as { code: unknown }).code === "ENOENT"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeKey(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * File-backed skill state store.
 *
 * Stores skill enable/disable state in a JSON file so that user preferences
 * survive across sessions. The file format is:
 *
 * ```json
 * {
 *   "skill-name": { "enabled": true },
 *   "other-skill": { "enabled": false }
 * }
 * ```
 *
 * Missing file on first load is handled gracefully (empty state).
 * `setEnabled()` triggers an immediate save.
 */
export class FileSkillStateStore implements SkillStateStore {
  private readonly filePath: string;
  private data: SkillStateData = {};

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  getEnabled(skillName: string): boolean | undefined {
    const entry = this.data[normalizeKey(skillName)];
    return entry?.enabled;
  }

  setEnabled(skillName: string, enabled: boolean): void {
    this.data[normalizeKey(skillName)] = { enabled };
    void this.save();
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed: unknown = JSON.parse(raw);

      if (isRecord(parsed)) {
        const cleaned: SkillStateData = {};

        for (const [key, value] of Object.entries(parsed)) {
          if (isRecord(value) && typeof value.enabled === "boolean") {
            cleaned[normalizeKey(key)] = { enabled: value.enabled };
          }
        }

        this.data = cleaned;
      }
    } catch (error: unknown) {
      if (isMissingFileError(error)) {
        // First run — no persisted state yet
        this.data = {};
        return;
      }

      // Corrupt file — start fresh rather than crash
      this.data = {};
    }
  }

  async save(): Promise<void> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(this.filePath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    } catch (e) {
      // Expected: best-effort persistence — don't crash on write failure
      log.warn("failed to persist skill state", { error: e instanceof Error ? e.message : String(e) });
    }
  }
}
