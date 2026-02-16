import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { validateSkillDirectory } from "../../src/skills/validator";
import { SkillError, SKILL_ERROR_CODES } from "../../src/skills/errors";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reins-skill-validator-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const MINIMAL_SKILL_MD = `---
name: test-skill
description: A test skill
---

# Test Skill
`;

describe("validateSkillDirectory", () => {
  describe("valid directories", () => {
    it("validates a directory with only SKILL.md", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "my-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("my-skill");
      expect(result.value.path).toBe(skillDir);
      expect(result.value.hasSkillMd).toBe(true);
      expect(result.value.hasScripts).toBe(false);
      expect(result.value.hasIntegrationMd).toBe(false);
      expect(result.value.scriptFiles).toEqual([]);
      expect(result.value.resourceFiles).toEqual([]);
    });

    it("detects scripts/ directory with files", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "scripted-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);
      await mkdir(join(skillDir, "scripts"));
      await writeFile(join(skillDir, "scripts", "setup.sh"), "#!/bin/bash\necho setup");
      await writeFile(join(skillDir, "scripts", "run.sh"), "#!/bin/bash\necho run");

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hasScripts).toBe(true);
      expect(result.value.scriptFiles).toEqual(["run.sh", "setup.sh"]);
    });

    it("detects INTEGRATION.md when present", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "integration-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);
      await writeFile(join(skillDir, "INTEGRATION.md"), "# Setup\n\nInstall deps.");

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hasIntegrationMd).toBe(true);
    });

    it("enumerates resource files excluding SKILL.md, INTEGRATION.md, and scripts/", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "resource-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);
      await writeFile(join(skillDir, "README.md"), "# Readme");
      await writeFile(join(skillDir, "data.json"), "{}");
      await writeFile(join(skillDir, "config.yaml"), "key: value");

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.resourceFiles).toEqual(["README.md", "config.yaml", "data.json"]);
    });

    it("handles a full directory with all optional components", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "full-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);
      await writeFile(join(skillDir, "INTEGRATION.md"), "# Integration");
      await mkdir(join(skillDir, "scripts"));
      await writeFile(join(skillDir, "scripts", "deploy.sh"), "#!/bin/bash");
      await writeFile(join(skillDir, "scripts", "build.sh"), "#!/bin/bash");
      await writeFile(join(skillDir, "README.md"), "# Full Skill");
      await writeFile(join(skillDir, "template.txt"), "template content");

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("full-skill");
      expect(result.value.hasSkillMd).toBe(true);
      expect(result.value.hasScripts).toBe(true);
      expect(result.value.hasIntegrationMd).toBe(true);
      expect(result.value.scriptFiles).toEqual(["build.sh", "deploy.sh"]);
      expect(result.value.resourceFiles).toEqual(["README.md", "template.txt"]);
    });

    it("reports empty scripts/ directory as hasScripts true with no files", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "empty-scripts-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);
      await mkdir(join(skillDir, "scripts"));

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hasScripts).toBe(true);
      expect(result.value.scriptFiles).toEqual([]);
    });

    it("excludes subdirectories from resource files", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "subdir-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);
      await mkdir(join(skillDir, "data"));
      await writeFile(join(skillDir, "notes.txt"), "notes");

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // "data" directory should not appear in resourceFiles
      expect(result.value.resourceFiles).toEqual(["notes.txt"]);
    });

    it("excludes subdirectories from script files", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "nested-scripts-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);
      await mkdir(join(skillDir, "scripts"));
      await writeFile(join(skillDir, "scripts", "run.sh"), "#!/bin/bash");
      await mkdir(join(skillDir, "scripts", "lib"));

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.scriptFiles).toEqual(["run.sh"]);
    });
  });

  describe("error cases", () => {
    it("returns error for non-existent directory", async () => {
      const result = await validateSkillDirectory("/tmp/does-not-exist-reins-test-xyz");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("does not exist");
      expect(result.error.code).toBe(SKILL_ERROR_CODES.NOT_FOUND);
    });

    it("returns error when path points to a file", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "not-a-dir.txt");
      await writeFile(filePath, "just a file");

      const result = await validateSkillDirectory(filePath);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("not a directory");
      expect(result.error.code).toBe(SKILL_ERROR_CODES.VALIDATION);
    });

    it("returns error when SKILL.md is missing", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "no-skill-md");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "README.md"), "# Not a skill");

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("missing required SKILL.md");
      expect(result.error.code).toBe(SKILL_ERROR_CODES.NOT_FOUND);
    });

    it("returns error for empty directory (no SKILL.md)", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "empty-skill");
      await mkdir(skillDir);

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("missing required SKILL.md");
      expect(result.error.code).toBe(SKILL_ERROR_CODES.NOT_FOUND);
    });

    it("does not treat a SKILL.md directory as valid", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "dir-as-skillmd");
      await mkdir(skillDir);
      // Create SKILL.md as a directory, not a file
      await mkdir(join(skillDir, "SKILL.md"));

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("missing required SKILL.md");
      expect(result.error.code).toBe(SKILL_ERROR_CODES.NOT_FOUND);
    });
  });

  describe("path handling", () => {
    it("resolves relative paths to absolute", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "relative-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.path).toBe(skillDir);
      // Path should be absolute
      expect(result.value.path.startsWith("/")).toBe(true);
    });

    it("extracts directory name from path", async () => {
      const dir = await createTempDir();
      const skillDir = join(dir, "my-awesome-skill");
      await mkdir(skillDir);
      await writeFile(join(skillDir, "SKILL.md"), MINIMAL_SKILL_MD);

      const result = await validateSkillDirectory(skillDir);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe("my-awesome-skill");
    });
  });
});
