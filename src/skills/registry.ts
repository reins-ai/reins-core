import { SkillError } from "./errors";
import type { SkillStateStore } from "./state-store";
import type { Skill, SkillSummary } from "./types";

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

export { normalizeSkillName };

export interface SkillRegistryOptions {
  stateStore?: SkillStateStore;
}

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();
  private readonly stateStore?: SkillStateStore;

  constructor(options?: SkillRegistryOptions) {
    this.stateStore = options?.stateStore;
  }

  register(skill: Skill): void {
    const name = normalizeSkillName(skill.config.name);

    if (this.skills.has(name)) {
      throw new SkillError(`Skill already registered: ${name}`);
    }

    // Apply persisted enabled state if available
    const persisted = this.stateStore?.getEnabled(name);
    if (persisted !== undefined) {
      skill.config.enabled = persisted;
    }

    this.skills.set(name, skill);
  }

  get(name: string): Skill | undefined {
    return this.skills.get(normalizeSkillName(name));
  }

  getOrThrow(name: string): Skill {
    const skill = this.get(name);

    if (!skill) {
      throw new SkillError(`Skill not found: ${name}`);
    }

    return skill;
  }

  list(): Skill[] {
    return Array.from(this.skills.values());
  }

  remove(name: string): boolean {
    return this.skills.delete(normalizeSkillName(name));
  }

  has(name: string): boolean {
    return this.skills.has(normalizeSkillName(name));
  }

  clear(): void {
    this.skills.clear();
  }

  enable(name: string): boolean {
    const skill = this.get(name);
    if (!skill) {
      return false;
    }

    skill.config.enabled = true;
    this.stateStore?.setEnabled(normalizeSkillName(name), true);
    return true;
  }

  disable(name: string): boolean {
    const skill = this.get(name);
    if (!skill) {
      return false;
    }

    skill.config.enabled = false;
    this.stateStore?.setEnabled(normalizeSkillName(name), false);
    return true;
  }

  listEnabled(): Skill[] {
    return this.list().filter((skill) => skill.config.enabled);
  }

  listByCategory(category: string): Skill[] {
    return this.list().filter((skill) => skill.categories.includes(category));
  }

  getSummaries(): SkillSummary[] {
    return this.listEnabled().map((skill) => ({ ...skill.summary }));
  }
}
