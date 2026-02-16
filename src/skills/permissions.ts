import type { Skill } from "./types";

export type PermissionResult = "granted" | "denied" | "session_granted";

/**
 * Interface for requesting user permission to execute a skill script.
 * Implementations are platform-specific (TUI prompt, desktop dialog, etc.)
 */
export interface SkillPermissionChecker {
  /**
   * Request permission to execute a script from a skill.
   * Returns "granted" if user approves, "denied" if user rejects.
   */
  requestPermission(skill: Skill, scriptName: string): Promise<PermissionResult>;
}

/**
 * Default permission checker that always denies - safe for headless/test contexts.
 */
export class AutoDenyPermissionChecker implements SkillPermissionChecker {
  async requestPermission(_skill: Skill, _scriptName: string): Promise<PermissionResult> {
    return "denied";
  }
}

/**
 * Permission checker that always grants - for testing purposes only.
 */
export class AutoGrantPermissionChecker implements SkillPermissionChecker {
  async requestPermission(_skill: Skill, _scriptName: string): Promise<PermissionResult> {
    return "granted";
  }
}

/**
 * Enforces trust-based permission policy for skill script execution.
 * - Trusted/verified skills: always granted
 * - Untrusted skills: delegates to checker, caches session grants
 */
export class SkillPermissionPolicy {
  private readonly checker: SkillPermissionChecker;
  private readonly sessionGrants = new Set<string>();

  constructor(checker?: SkillPermissionChecker) {
    this.checker = checker ?? new AutoDenyPermissionChecker();
  }

  /**
   * Check if a script execution is permitted.
   */
  async checkPermission(skill: Skill, scriptName: string): Promise<PermissionResult> {
    if (skill.config.trustLevel === "trusted" || skill.config.trustLevel === "verified") {
      return "granted";
    }

    const cacheKey = this.getCacheKey(skill.config.name, scriptName);
    if (this.sessionGrants.has(cacheKey)) {
      return "session_granted";
    }

    const result = await this.checker.requestPermission(skill, scriptName);
    if (result === "granted" || result === "session_granted") {
      this.sessionGrants.add(cacheKey);
      return "session_granted";
    }

    return "denied";
  }

  /**
   * Clear all session grants (e.g., on session end).
   */
  clearSessionGrants(): void {
    this.sessionGrants.clear();
  }

  /**
   * Check if a skill has a session grant for a specific script.
   */
  hasSessionGrant(skillName: string, scriptName: string): boolean {
    return this.sessionGrants.has(this.getCacheKey(skillName, scriptName));
  }

  private getCacheKey(skillName: string, scriptName: string): string {
    return `${skillName}:${scriptName}`;
  }
}
