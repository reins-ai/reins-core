export type SkillTrustLevel = "trusted" | "untrusted" | "verified";

export type SkillStatus = "enabled" | "disabled";

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillConfig {
  name: string;
  enabled: boolean;
  trustLevel: SkillTrustLevel;
  path: string;
}

export interface Skill {
  readonly config: SkillConfig;
  readonly summary: SkillSummary;
  hasScripts: boolean;
  hasIntegration: boolean;
  scriptFiles: string[];
  categories: string[];
}
