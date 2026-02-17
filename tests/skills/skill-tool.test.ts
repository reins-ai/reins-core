import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

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

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reins-skill-tool-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

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

  describe("post-start install (disk fallback)", () => {
    it("loads skill from disk when scanner cache misses", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "summarize");
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---
name: summarize
description: Summarize text content
triggers: [summarize, tldr]
categories: [writing]
version: 1.0.0
---

# Summarize

Condense long text into key points.
`,
      );

      const registry = new SkillRegistry();
      registry.register(createSkill({
        name: "summarize",
        path: skillDir,
      }));

      // Empty scanner cache — simulates skill added after initial scan
      const scanner = new MockSkillScanner(new Map());
      const tool = new SkillTool(registry, scanner);

      const result = await tool.execute(
        { callId: "post-start-1", name: "summarize" },
        createContext(),
      );

      expect(result.error).toBeUndefined();
      expect(result.result).not.toBeNull();

      const data = result.result as {
        name: string;
        body: string;
        metadata: SkillMetadata;
      };
      expect(data.name).toBe("summarize");
      expect(data.body).toBe("# Summarize\n\nCondense long text into key points.");
      expect(data.metadata.name).toBe("summarize");
      expect(data.metadata.description).toBe("Summarize text content");
    });

    it("returns error when both scanner cache and disk fail", async () => {
      const registry = new SkillRegistry();
      registry.register(createSkill({
        name: "ghost-skill",
        path: "/tmp/does-not-exist-reins-ghost-xyz",
      }));

      const scanner = new MockSkillScanner(new Map());
      const tool = new SkillTool(registry, scanner);

      const result = await tool.execute(
        { callId: "post-start-2", name: "ghost-skill" },
        createContext(),
      );

      expect(result.result).toBeNull();
      expect(result.error).toBe("Failed to load content for skill: ghost-skill");
    });

    it("prefers scanner cache over disk when both available", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "cached-skill");
      await mkdir(skillDir);
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---
name: cached-skill
description: Disk version
---

# Disk Body
`,
      );

      const registry = new SkillRegistry();
      registry.register(createSkill({
        name: "cached-skill",
        path: skillDir,
      }));

      const scanner = new MockSkillScanner(
        new Map([
          [
            "cached-skill",
            {
              body: "# Cache Body",
              metadata: createMetadata("cached-skill"),
              raw: "---\nname: cached-skill\n---\n\n# Cache Body",
            },
          ],
        ]),
      );

      const tool = new SkillTool(registry, scanner);
      const result = await tool.execute(
        { callId: "post-start-3", name: "cached-skill" },
        createContext(),
      );

      expect(result.error).toBeUndefined();
      const data = result.result as { body: string };
      expect(data.body).toBe("# Cache Body");
    });

    it("handles invalid SKILL.md on disk gracefully", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "bad-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), "not valid frontmatter");

      const registry = new SkillRegistry();
      registry.register(createSkill({
        name: "bad-skill",
        path: skillDir,
      }));

      const scanner = new MockSkillScanner(new Map());
      const tool = new SkillTool(registry, scanner);

      const result = await tool.execute(
        { callId: "post-start-4", name: "bad-skill" },
        createContext(),
      );

      expect(result.result).toBeNull();
      expect(result.error).toBe("Failed to load content for skill: bad-skill");
    });
  });
});
