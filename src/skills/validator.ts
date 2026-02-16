import { readdir, stat } from "node:fs/promises";
import { join, basename, resolve } from "node:path";

import { SkillError, SKILL_ERROR_CODES } from "./errors";
import { type Result, err, ok } from "../result";

/**
 * Describes the validated structure of a skill directory.
 */
export interface SkillDirectoryInfo {
  /** Absolute path to the skill directory */
  path: string;
  /** Directory name (used as default skill name if not in metadata) */
  name: string;
  /** Whether SKILL.md exists */
  hasSkillMd: boolean;
  /** Whether scripts/ directory exists */
  hasScripts: boolean;
  /** Whether INTEGRATION.md exists */
  hasIntegrationMd: boolean;
  /** List of script filenames in scripts/ */
  scriptFiles: string[];
  /** List of additional resource files (not SKILL.md, INTEGRATION.md, or scripts/) */
  resourceFiles: string[];
}

const SKILL_MD = "SKILL.md";
const INTEGRATION_MD = "INTEGRATION.md";
const SCRIPTS_DIR = "scripts";

/** Entries that are not counted as resource files */
const EXCLUDED_FROM_RESOURCES = new Set([SKILL_MD, INTEGRATION_MD, SCRIPTS_DIR]);

/**
 * Validate a skill directory structure.
 *
 * Checks for the required SKILL.md file, detects optional scripts/ directory
 * and INTEGRATION.md, and enumerates script files and resource files.
 *
 * Returns a `SkillDirectoryInfo` describing the directory contents, or a
 * `SkillError` if the directory is invalid (missing, not a directory, or
 * missing the required SKILL.md).
 */
export async function validateSkillDirectory(
  dirPath: string,
): Promise<Result<SkillDirectoryInfo, SkillError>> {
  const absolutePath = resolve(dirPath);

  // 1. Verify the path exists and is a directory
  let dirStat;
  try {
    dirStat = await stat(absolutePath);
  } catch {
    return err(new SkillError(`Skill directory does not exist: "${absolutePath}"`, SKILL_ERROR_CODES.NOT_FOUND));
  }

  if (!dirStat.isDirectory()) {
    return err(new SkillError(`Path is not a directory: "${absolutePath}"`, SKILL_ERROR_CODES.VALIDATION));
  }

  // 2. Read directory entries
  let entries;
  try {
    entries = await readdir(absolutePath, { withFileTypes: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return err(new SkillError(`Failed to read skill directory "${absolutePath}": ${message}`, SKILL_ERROR_CODES.PERMISSION));
  }

  // 3. Check for required SKILL.md
  const hasSkillMd = entries.some(
    (entry) => entry.name === SKILL_MD && entry.isFile(),
  );

  if (!hasSkillMd) {
    return err(
      new SkillError(`Skill directory is missing required ${SKILL_MD}: "${absolutePath}"`, SKILL_ERROR_CODES.NOT_FOUND),
    );
  }

  // 4. Check for scripts/ directory and enumerate its files
  const scriptsEntry = entries.find(
    (entry) => entry.name === SCRIPTS_DIR && entry.isDirectory(),
  );
  const hasScripts = scriptsEntry !== undefined;
  let scriptFiles: string[] = [];

  if (hasScripts) {
    try {
      const scriptEntries = await readdir(join(absolutePath, SCRIPTS_DIR), {
        withFileTypes: true,
      });
      scriptFiles = scriptEntries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(
        new SkillError(`Failed to read scripts directory "${join(absolutePath, SCRIPTS_DIR)}": ${message}`, SKILL_ERROR_CODES.PERMISSION),
      );
    }
  }

  // 5. Check for INTEGRATION.md
  const hasIntegrationMd = entries.some(
    (entry) => entry.name === INTEGRATION_MD && entry.isFile(),
  );

  // 6. Enumerate resource files (everything except SKILL.md, INTEGRATION.md, scripts/)
  const resourceFiles = entries
    .filter((entry) => entry.isFile() && !EXCLUDED_FROM_RESOURCES.has(entry.name))
    .map((entry) => entry.name)
    .sort();

  return ok({
    path: absolutePath,
    name: basename(absolutePath),
    hasSkillMd,
    hasScripts,
    hasIntegrationMd,
    scriptFiles,
    resourceFiles,
  });
}
