import { describe, expect, it } from "bun:test";

import {
  SKILL_TOOL_DEFINITION,
  SkillRegistry,
  SkillScanner,
  SkillTool,
  normalizeSkillName,
  type Skill,
  type SkillMetadata,
} from "../../src/skills";
import type { ToolContext } from "../../src/types";

type LoadedSkillContent = {
  body: string;
  metadata: SkillMetadata;
  raw: string;
};

class MockSkillScanner extends SkillScanner {
  constructor(
    private readonly loadedSkills: Map<string, LoadedSkillContent>,
    private readonly throwMessage?: string,
  ) {
    super(new SkillRegistry(), "/tmp/mock-skills");
  }

  override loadSkill(name: string): LoadedSkillContent | undefined {
    if (this.throwMessage) {
      throw new Error(this.throwMessage);
    }

    return this.loadedSkills.get(normalizeSkillName(name));
  }
}

function createContext(): ToolContext {
  return {
    conversationId: "conversation-1",
    userId: "user-1",
  };
}

function createSkill(overrides?: Partial<Skill["config"]> & {
  hasIntegration?: boolean;
  scriptFiles?: string[];
}): Skill {
  const hasIntegration = overrides?.hasIntegration ?? false;
  const scriptFiles = overrides?.scriptFiles ?? [];

  return {
    config: {
      name: overrides?.name ?? "git-helper",
      enabled: overrides?.enabled ?? true,
      trustLevel: overrides?.trustLevel ?? "trusted",
      path: overrides?.path ?? "/skills/git-helper",
    },
    summary: {
      name: overrides?.name ?? "git-helper",
      description: "Helps with git workflows",
    },
    hasScripts: scriptFiles.length > 0,
    hasIntegration,
    scriptFiles,
    categories: ["dev"],
    triggers: ["git", "branch"],
  };
}

function createMetadata(name = "git-helper"): SkillMetadata {
  return {
    name,
    description: "Helps with git workflows",
    triggers: ["git", "branch"],
    categories: ["dev"],
    trustLevel: "trusted",
    version: "1.0.0",
  };
}

describe("SKILL_TOOL_DEFINITION", () => {
  it("defines the load_skill tool schema", () => {
    expect(SKILL_TOOL_DEFINITION.name).toBe("load_skill");
    expect(SKILL_TOOL_DEFINITION.parameters.type).toBe("object");
    expect(SKILL_TOOL_DEFINITION.parameters.required).toEqual(["name"]);
    expect(SKILL_TOOL_DEFINITION.parameters.properties.name).toEqual({
      type: "string",
      description: "Skill name to load.",
    });
  });
});

describe("SkillTool", () => {
  it("returns full skill content for a valid enabled skill", async () => {
    const registry = new SkillRegistry();
    const skill = createSkill({
      name: "git-helper",
      hasIntegration: true,
      scriptFiles: ["plan.sh", "status.sh"],
    });
    registry.register(skill);

    const scanner = new MockSkillScanner(
      new Map([
        [
          "git-helper",
          {
            body: "# Git Helper\n\nRun safe git commands.",
            metadata: createMetadata("git-helper"),
            raw: "---\nname: git-helper\n---\n\n# Git Helper",
          },
        ],
      ]),
    );

    const tool = new SkillTool(registry, scanner);
    const result = await tool.execute({ callId: "call-1", name: "git-helper" }, createContext());

    expect(result.error).toBeUndefined();
    expect(result.callId).toBe("call-1");
    expect(result.name).toBe("load_skill");
    expect(result.result).toEqual({
      name: "git-helper",
      body: "# Git Helper\n\nRun safe git commands.",
      metadata: createMetadata("git-helper"),
      scripts: ["plan.sh", "status.sh"],
      integrationStatus: "needs_setup",
    });
  });

  it("returns error when skill is not found", async () => {
    const registry = new SkillRegistry();
    const scanner = new MockSkillScanner(new Map());
    const tool = new SkillTool(registry, scanner);

    const result = await tool.execute({ callId: "call-2", name: "unknown-skill" }, createContext());

    expect(result.result).toBeNull();
    expect(result.error).toBe("Skill not found: unknown-skill");
  });

  it("returns error when skill is disabled", async () => {
    const registry = new SkillRegistry();
    registry.register(createSkill({ name: "disabled-skill", enabled: false }));

    const scanner = new MockSkillScanner(new Map());
    const tool = new SkillTool(registry, scanner);

    const result = await tool.execute({ callId: "call-3", name: "disabled-skill" }, createContext());

    expect(result.result).toBeNull();
    expect(result.error).toBe("Skill is disabled: disabled-skill");
  });

  it("returns error when scanner cannot load content", async () => {
    const registry = new SkillRegistry();
    registry.register(createSkill({ name: "missing-content" }));

    const scanner = new MockSkillScanner(new Map());
    const tool = new SkillTool(registry, scanner);

    const result = await tool.execute({ callId: "call-4", name: "missing-content" }, createContext());

    expect(result.result).toBeNull();
    expect(result.error).toBe("Failed to load content for skill: missing-content");
  });

  it("returns error when scanner throws during load", async () => {
    const registry = new SkillRegistry();
    registry.register(createSkill({ name: "throwing-skill" }));

    const scanner = new MockSkillScanner(new Map(), "content cache unavailable");
    const tool = new SkillTool(registry, scanner);

    const result = await tool.execute({ callId: "call-5", name: "throwing-skill" }, createContext());

    expect(result.result).toBeNull();
    expect(result.error).toBe("content cache unavailable");
  });

  it("returns error when name parameter is missing", async () => {
    const registry = new SkillRegistry();
    const scanner = new MockSkillScanner(new Map());
    const tool = new SkillTool(registry, scanner);

    const result = await tool.execute({ callId: "call-6" }, createContext());

    expect(result.result).toBeNull();
    expect(result.error).toBe("Missing or invalid 'name' argument.");
  });

  it("defaults callId when callId argument is missing", async () => {
    const registry = new SkillRegistry();
    registry.register(createSkill({ name: "fallback-call-id" }));

    const scanner = new MockSkillScanner(
      new Map([
        [
          "fallback-call-id",
          {
            body: "# Fallback",
            metadata: createMetadata("fallback-call-id"),
            raw: "---\nname: fallback-call-id\n---",
          },
        ],
      ]),
    );

    const tool = new SkillTool(registry, scanner);
    const result = await tool.execute({ name: "fallback-call-id" }, createContext());

    expect(result.callId).toBe("unknown-call");
    expect(result.error).toBeUndefined();
  });
});
