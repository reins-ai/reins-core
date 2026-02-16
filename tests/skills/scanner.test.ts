import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SkillScanner } from "../../src/skills/scanner";
import { SkillRegistry } from "../../src/skills/registry";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reins-skill-scanner-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill for unit testing
triggers:
  - test
  - testing
categories:
  - testing
---

# Test Skill

This is a test skill.
`;

function makeSkillMd(name: string, description?: string): string {
  return `---
name: ${name}
description: ${description ?? `Description for ${name}`}
---

# ${name}

Body content for ${name}.
`;
}

describe("SkillScanner", () => {
  describe("scan", () => {
    it("discovers and registers multiple valid skills", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "skill-a"));
      await writeFile(join(dir, "skill-a", "SKILL.md"), makeSkillMd("skill-a"));

      await mkdir(join(dir, "skill-b"));
      await writeFile(join(dir, "skill-b", "SKILL.md"), makeSkillMd("skill-b"));

      await mkdir(join(dir, "skill-c"));
      await writeFile(join(dir, "skill-c", "SKILL.md"), makeSkillMd("skill-c"));

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      const report = await scanner.scan();

      expect(report.discovered).toBe(3);
      expect(report.loaded).toBe(3);
      expect(report.errors).toHaveLength(0);
      expect(report.skipped).toBe(0);

      expect(registry.has("skill-a")).toBe(true);
      expect(registry.has("skill-b")).toBe(true);
      expect(registry.has("skill-c")).toBe(true);
      expect(registry.list()).toHaveLength(3);
    });

    it("registers skills with correct metadata from SKILL.md", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "my-skill"));
      await writeFile(join(dir, "my-skill", "SKILL.md"), VALID_SKILL_MD);

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      const skill = registry.getOrThrow("test-skill");
      expect(skill.config.name).toBe("test-skill");
      expect(skill.config.enabled).toBe(true);
      expect(skill.config.trustLevel).toBe("untrusted");
      expect(skill.summary.description).toBe("A test skill for unit testing");
      expect(skill.categories).toEqual(["testing"]);
    });

    it("detects scripts and integration files in skill directories", async () => {
      const dir = await createTempDir();

      const skillDir = join(dir, "full-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), makeSkillMd("full-skill"));
      await mkdir(join(skillDir, "scripts"));
      await writeFile(join(skillDir, "scripts", "run.sh"), "#!/bin/bash\necho hi");
      await writeFile(join(skillDir, "INTEGRATION.md"), "# Setup\n\nDo things.");

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      const skill = registry.getOrThrow("full-skill");
      expect(skill.hasScripts).toBe(true);
      expect(skill.hasIntegration).toBe(true);
      expect(skill.scriptFiles).toEqual(["run.sh"]);
    });

    it("handles mix of valid and invalid skills gracefully", async () => {
      const dir = await createTempDir();

      // Valid skill
      await mkdir(join(dir, "good-skill"));
      await writeFile(join(dir, "good-skill", "SKILL.md"), makeSkillMd("good-skill"));

      // Invalid: missing SKILL.md
      await mkdir(join(dir, "bad-skill"));
      await writeFile(join(dir, "bad-skill", "README.md"), "# Not a skill");

      // Another valid skill
      await mkdir(join(dir, "another-good"));
      await writeFile(join(dir, "another-good", "SKILL.md"), makeSkillMd("another-good"));

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      const report = await scanner.scan();

      expect(report.discovered).toBe(3);
      expect(report.loaded).toBe(2);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].skillDir).toContain("bad-skill");
      expect(report.errors[0].error).toContain("missing required SKILL.md");

      expect(registry.has("good-skill")).toBe(true);
      expect(registry.has("another-good")).toBe(true);
    });

    it("returns empty report for empty directory", async () => {
      const dir = await createTempDir();

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      const report = await scanner.scan();

      expect(report.discovered).toBe(0);
      expect(report.loaded).toBe(0);
      expect(report.errors).toHaveLength(0);
      expect(report.skipped).toBe(0);
      expect(registry.list()).toHaveLength(0);
    });

    it("returns empty report for non-existent directory without crashing", async () => {
      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, "/tmp/does-not-exist-reins-scanner-xyz");
      const report = await scanner.scan();

      expect(report.discovered).toBe(0);
      expect(report.loaded).toBe(0);
      expect(report.errors).toHaveLength(0);
      expect(report.skipped).toBe(0);
    });

    it("skips non-directory entries and counts them", async () => {
      const dir = await createTempDir();

      // Regular file at top level (not a skill directory)
      await writeFile(join(dir, "README.md"), "# Skills");
      await writeFile(join(dir, ".gitkeep"), "");

      // Valid skill directory
      await mkdir(join(dir, "real-skill"));
      await writeFile(join(dir, "real-skill", "SKILL.md"), makeSkillMd("real-skill"));

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      const report = await scanner.scan();

      expect(report.skipped).toBe(2);
      expect(report.discovered).toBe(1);
      expect(report.loaded).toBe(1);
    });

    it("reports error for skill with invalid SKILL.md content", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "broken-skill"));
      await writeFile(join(dir, "broken-skill", "SKILL.md"), "no frontmatter here");

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      const report = await scanner.scan();

      expect(report.discovered).toBe(1);
      expect(report.loaded).toBe(0);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].skillDir).toContain("broken-skill");
    });

    it("reports error for skill with missing required metadata fields", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "no-name-skill"));
      await writeFile(
        join(dir, "no-name-skill", "SKILL.md"),
        `---
description: Missing the name field
---

# Oops
`,
      );

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      const report = await scanner.scan();

      expect(report.discovered).toBe(1);
      expect(report.loaded).toBe(0);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].error).toContain("name");
    });

    it("reports duplicate skill names as errors (first wins)", async () => {
      const dir = await createTempDir();

      // Two directories with skills that have the same metadata name
      await mkdir(join(dir, "dir-one"));
      await writeFile(join(dir, "dir-one", "SKILL.md"), makeSkillMd("duplicate-name"));

      await mkdir(join(dir, "dir-two"));
      await writeFile(join(dir, "dir-two", "SKILL.md"), makeSkillMd("duplicate-name"));

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      const report = await scanner.scan();

      expect(report.discovered).toBe(2);
      expect(report.loaded).toBe(1);
      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].error).toContain("already registered");

      // Only one should be in the registry
      expect(registry.list()).toHaveLength(1);
      expect(registry.has("duplicate-name")).toBe(true);
    });

    it("uses metadata trust level when specified", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "trusted-skill"));
      await writeFile(
        join(dir, "trusted-skill", "SKILL.md"),
        `---
name: trusted-skill
description: A trusted skill
trustLevel: trusted
---

# Trusted
`,
      );

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      const skill = registry.getOrThrow("trusted-skill");
      expect(skill.config.trustLevel).toBe("trusted");
    });

    it("defaults trust level to untrusted when not specified", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "default-trust"));
      await writeFile(join(dir, "default-trust", "SKILL.md"), makeSkillMd("default-trust"));

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      const skill = registry.getOrThrow("default-trust");
      expect(skill.config.trustLevel).toBe("untrusted");
    });

    it("sets skill path to the absolute directory path", async () => {
      const dir = await createTempDir();

      const skillDir = join(dir, "path-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), makeSkillMd("path-skill"));

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      const skill = registry.getOrThrow("path-skill");
      expect(skill.config.path).toBe(skillDir);
    });
  });

  describe("loadSkill", () => {
    it("returns cached content for a registered skill", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "loadable"));
      await writeFile(join(dir, "loadable", "SKILL.md"), VALID_SKILL_MD);

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      const content = scanner.loadSkill("test-skill");

      expect(content).toBeDefined();
      expect(content!.metadata.name).toBe("test-skill");
      expect(content!.metadata.description).toBe("A test skill for unit testing");
      expect(content!.metadata.triggers).toEqual(["test", "testing"]);
      expect(content!.body).toContain("# Test Skill");
      expect(content!.body).toContain("This is a test skill.");
      expect(content!.raw).toBe(VALID_SKILL_MD);
    });

    it("returns undefined for unknown skill name", () => {
      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, "/tmp/nonexistent");

      expect(scanner.loadSkill("unknown")).toBeUndefined();
    });

    it("normalizes skill name for lookup", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "cased-skill"));
      await writeFile(join(dir, "cased-skill", "SKILL.md"), makeSkillMd("cased-skill"));

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      expect(scanner.loadSkill("  CASED-SKILL  ")).toBeDefined();
      expect(scanner.loadSkill("cased-skill")).toBeDefined();
    });

    it("does not cache content for skills that failed to load", async () => {
      const dir = await createTempDir();

      // Invalid skill
      await mkdir(join(dir, "broken"));
      await writeFile(join(dir, "broken", "SKILL.md"), "not valid");

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      expect(scanner.loadSkill("broken")).toBeUndefined();
    });
  });

  describe("integration with registry", () => {
    it("all registered skills are enabled by default", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "alpha"));
      await writeFile(join(dir, "alpha", "SKILL.md"), makeSkillMd("alpha"));

      await mkdir(join(dir, "beta"));
      await writeFile(join(dir, "beta", "SKILL.md"), makeSkillMd("beta"));

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      const enabled = registry.listEnabled();
      expect(enabled).toHaveLength(2);
    });

    it("getSummaries returns summaries for all discovered skills", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "summary-skill"));
      await writeFile(
        join(dir, "summary-skill", "SKILL.md"),
        makeSkillMd("summary-skill", "A skill with a summary"),
      );

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      const summaries = registry.getSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toEqual({
        name: "summary-skill",
        description: "A skill with a summary",
      });
    });

    it("does not interfere with pre-existing registry entries", async () => {
      const dir = await createTempDir();

      await mkdir(join(dir, "new-skill"));
      await writeFile(join(dir, "new-skill", "SKILL.md"), makeSkillMd("new-skill"));

      const registry = new SkillRegistry();

      // Pre-register a skill manually
      registry.register({
        config: { name: "existing", enabled: true, trustLevel: "trusted", path: "/existing" },
        summary: { name: "existing", description: "Pre-existing skill" },
        hasScripts: false,
        hasIntegration: false,
        scriptFiles: [],
        categories: [],
      });

      const scanner = new SkillScanner(registry, dir);
      const report = await scanner.scan();

      expect(report.loaded).toBe(1);
      expect(registry.list()).toHaveLength(2);
      expect(registry.has("existing")).toBe(true);
      expect(registry.has("new-skill")).toBe(true);
    });
  });
});
