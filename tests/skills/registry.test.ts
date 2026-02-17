import { describe, expect, it } from "bun:test";

import { SkillError } from "../../src/skills/errors";
import { normalizeSkillName, SkillRegistry } from "../../src/skills/registry";
import type { SkillStateStore } from "../../src/skills/state-store";
import type { Skill, SkillConfig } from "../../src/skills/types";

function createTestSkill(
  overrides: Partial<Skill> & { config: Partial<SkillConfig> & { name: string } },
): Skill {
  return {
    config: {
      enabled: true,
      trustLevel: "untrusted",
      path: `/home/user/.reins/skills/${overrides.config.name}`,
      ...overrides.config,
    },
    summary: {
      name: overrides.config.name,
      description: overrides.summary?.description ?? `Description for ${overrides.config.name}`,
    },
    hasScripts: overrides.hasScripts ?? false,
    hasIntegration: overrides.hasIntegration ?? false,
    scriptFiles: overrides.scriptFiles ?? [],
    categories: overrides.categories ?? [],
    triggers: overrides.triggers ?? [],
  };
}

describe("normalizeSkillName", () => {
  it("lowercases and trims the name", () => {
    expect(normalizeSkillName("  My-Skill  ")).toBe("my-skill");
  });

  it("handles already-normalized names", () => {
    expect(normalizeSkillName("git-helper")).toBe("git-helper");
  });
});

describe("SkillRegistry", () => {
  it("registers and gets a skill by name", () => {
    const registry = new SkillRegistry();
    const skill = createTestSkill({ config: { name: "git-helper" } });

    registry.register(skill);

    expect(registry.get("git-helper")).toBe(skill);
    expect(registry.has("git-helper")).toBe(true);
  });

  it("normalizes skill names for register, get, has, and remove", () => {
    const registry = new SkillRegistry();
    const skill = createTestSkill({ config: { name: "  Git-Helper  " } });

    registry.register(skill);

    expect(registry.get("git-helper")).toBe(skill);
    expect(registry.get(" GIT-HELPER ")).toBe(skill);
    expect(registry.has(" Git-Helper")).toBe(true);
    expect(registry.remove(" git-helper ")).toBe(true);
    expect(registry.has("git-helper")).toBe(false);
  });

  it("throws SkillError on duplicate registration", () => {
    const registry = new SkillRegistry();

    registry.register(createTestSkill({ config: { name: "docker-compose" } }));

    expect(() =>
      registry.register(createTestSkill({ config: { name: " DOCKER-COMPOSE " } })),
    ).toThrow(SkillError);
  });

  it("returns all skills in registration order", () => {
    const registry = new SkillRegistry();
    const first = createTestSkill({ config: { name: "git-helper" } });
    const second = createTestSkill({ config: { name: "docker-compose" } });

    registry.register(first);
    registry.register(second);

    expect(registry.list()).toEqual([first, second]);
  });

  it("getOrThrow returns skill when present", () => {
    const registry = new SkillRegistry();
    const skill = createTestSkill({ config: { name: "available" } });
    registry.register(skill);

    expect(registry.getOrThrow("available")).toBe(skill);
  });

  it("getOrThrow throws SkillError for unknown skill", () => {
    const registry = new SkillRegistry();

    expect(() => registry.getOrThrow("missing")).toThrow(SkillError);
  });

  it("removes skills and returns whether skill existed", () => {
    const registry = new SkillRegistry();
    registry.register(createTestSkill({ config: { name: "temporary" } }));

    expect(registry.remove("temporary")).toBe(true);
    expect(registry.remove("temporary")).toBe(false);
    expect(registry.has("temporary")).toBe(false);
  });

  it("clears all skills", () => {
    const registry = new SkillRegistry();
    registry.register(createTestSkill({ config: { name: "git-helper" } }));
    registry.register(createTestSkill({ config: { name: "docker-compose" } }));

    registry.clear();

    expect(registry.list()).toHaveLength(0);
    expect(registry.has("git-helper")).toBe(false);
    expect(registry.has("docker-compose")).toBe(false);
  });

  it("enables and disables skills", () => {
    const registry = new SkillRegistry();
    const skill = createTestSkill({ config: { name: "toggler", enabled: false } });
    registry.register(skill);

    expect(registry.enable(" TOGGLER ")).toBe(true);
    expect(skill.config.enabled).toBe(true);

    expect(registry.disable("toggler")).toBe(true);
    expect(skill.config.enabled).toBe(false);
  });

  it("returns false when toggling a missing skill", () => {
    const registry = new SkillRegistry();

    expect(registry.enable("missing")).toBe(false);
    expect(registry.disable("missing")).toBe(false);
  });

  it("lists only enabled skills", () => {
    const registry = new SkillRegistry();
    const enabled = createTestSkill({ config: { name: "active-skill", enabled: true } });
    const disabled = createTestSkill({ config: { name: "inactive-skill", enabled: false } });

    registry.register(enabled);
    registry.register(disabled);

    expect(registry.listEnabled()).toEqual([enabled]);
  });

  it("lists skills by category", () => {
    const registry = new SkillRegistry();
    const devTool = createTestSkill({
      config: { name: "git-helper" },
      categories: ["development", "git"],
    });
    const writing = createTestSkill({
      config: { name: "blog-writer" },
      categories: ["writing", "content"],
    });
    const devAndWriting = createTestSkill({
      config: { name: "docs-generator" },
      categories: ["development", "writing"],
    });

    registry.register(devTool);
    registry.register(writing);
    registry.register(devAndWriting);

    expect(registry.listByCategory("development")).toEqual([devTool, devAndWriting]);
    expect(registry.listByCategory("writing")).toEqual([writing, devAndWriting]);
    expect(registry.listByCategory("unknown")).toEqual([]);
  });

  it("getSummaries returns lightweight objects for enabled skills only", () => {
    const registry = new SkillRegistry();
    registry.register(createTestSkill({
      config: { name: "enabled-skill", enabled: true },
      summary: { name: "enabled-skill", description: "An enabled skill" },
    }));
    registry.register(createTestSkill({
      config: { name: "disabled-skill", enabled: false },
      summary: { name: "disabled-skill", description: "A disabled skill" },
    }));

    const summaries = registry.getSummaries();

    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      name: "enabled-skill",
      description: "An enabled skill",
    });
  });

  it("getSummaries returns copies not references", () => {
    const registry = new SkillRegistry();
    registry.register(createTestSkill({
      config: { name: "test-skill", enabled: true },
      summary: { name: "test-skill", description: "Original" },
    }));

    const summaries = registry.getSummaries();
    summaries[0].description = "Mutated";

    const freshSummaries = registry.getSummaries();
    expect(freshSummaries[0].description).toBe("Original");
  });

  it("get returns undefined for unregistered skill", () => {
    const registry = new SkillRegistry();

    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("getSummaries returns empty array when no skills are enabled", () => {
    const registry = new SkillRegistry();
    registry.register(createTestSkill({ config: { name: "disabled", enabled: false } }));

    expect(registry.getSummaries()).toEqual([]);
  });

  it("getSummaries returns empty array when registry is empty", () => {
    const registry = new SkillRegistry();

    expect(registry.getSummaries()).toEqual([]);
  });

  describe("hasEnabledScriptCapableSkills", () => {
    it("returns false when registry is empty", () => {
      const registry = new SkillRegistry();

      expect(registry.hasEnabledScriptCapableSkills()).toBe(false);
    });

    it("returns false when all skills lack scripts", () => {
      const registry = new SkillRegistry();
      registry.register(createTestSkill({
        config: { name: "summarize", enabled: true },
        hasScripts: false,
        scriptFiles: [],
      }));

      expect(registry.hasEnabledScriptCapableSkills()).toBe(false);
    });

    it("returns false when script-capable skill is disabled", () => {
      const registry = new SkillRegistry();
      registry.register(createTestSkill({
        config: { name: "deploy-helper", enabled: false },
        hasScripts: true,
        scriptFiles: ["deploy.sh"],
      }));

      expect(registry.hasEnabledScriptCapableSkills()).toBe(false);
    });

    it("returns true when at least one enabled skill has scripts", () => {
      const registry = new SkillRegistry();
      registry.register(createTestSkill({
        config: { name: "summarize", enabled: true },
        hasScripts: false,
        scriptFiles: [],
      }));
      registry.register(createTestSkill({
        config: { name: "deploy-helper", enabled: true },
        hasScripts: true,
        scriptFiles: ["deploy.sh"],
      }));

      expect(registry.hasEnabledScriptCapableSkills()).toBe(true);
    });

    it("returns false when hasScripts is true but scriptFiles is empty", () => {
      const registry = new SkillRegistry();
      registry.register(createTestSkill({
        config: { name: "broken-skill", enabled: true },
        hasScripts: true,
        scriptFiles: [],
      }));

      expect(registry.hasEnabledScriptCapableSkills()).toBe(false);
    });
  });

  describe("with SkillStateStore", () => {
    function createMockStateStore(state: Record<string, boolean> = {}): SkillStateStore & { calls: { name: string; enabled: boolean }[] } {
      const calls: { name: string; enabled: boolean }[] = [];
      return {
        calls,
        getEnabled(name: string) {
          return state[name];
        },
        setEnabled(name: string, enabled: boolean) {
          state[name] = enabled;
          calls.push({ name, enabled });
        },
        async load() {},
        async save() {},
      };
    }

    it("applies persisted enabled state on register", () => {
      const store = createMockStateStore({ "my-skill": false });
      const registry = new SkillRegistry({ stateStore: store });
      const skill = createTestSkill({ config: { name: "my-skill", enabled: true } });

      registry.register(skill);

      expect(skill.config.enabled).toBe(false);
    });

    it("does not override enabled state when store has no entry", () => {
      const store = createMockStateStore({});
      const registry = new SkillRegistry({ stateStore: store });
      const skill = createTestSkill({ config: { name: "new-skill", enabled: true } });

      registry.register(skill);

      expect(skill.config.enabled).toBe(true);
    });

    it("persists state on enable", () => {
      const store = createMockStateStore({});
      const registry = new SkillRegistry({ stateStore: store });
      registry.register(createTestSkill({ config: { name: "toggle-skill", enabled: false } }));

      registry.enable("toggle-skill");

      expect(store.calls).toEqual([{ name: "toggle-skill", enabled: true }]);
    });

    it("persists state on disable", () => {
      const store = createMockStateStore({});
      const registry = new SkillRegistry({ stateStore: store });
      registry.register(createTestSkill({ config: { name: "toggle-skill", enabled: true } }));

      registry.disable("toggle-skill");

      expect(store.calls).toEqual([{ name: "toggle-skill", enabled: false }]);
    });

    it("does not call state store when enable/disable targets missing skill", () => {
      const store = createMockStateStore({});
      const registry = new SkillRegistry({ stateStore: store });

      registry.enable("missing");
      registry.disable("missing");

      expect(store.calls).toEqual([]);
    });
  });
});
