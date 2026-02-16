import { SkillError } from "./errors";
import type { Skill, SkillSummary } from "./types";

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

export { normalizeSkillName };

export class SkillRegistry {
  private readonly skills = new Map<string, Skill>();

  register(skill: Skill): void {
    const name = normalizeSkillName(skill.config.name);

    if (this.skills.has(name)) {
      throw new SkillError(`Skill already registered: ${name}`);
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
    return true;
  }

  disable(name: string): boolean {
    const skill = this.get(name);
    if (!skill) {
      return false;
    }

    skill.config.enabled = false;
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
