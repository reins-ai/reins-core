import { afterEach, describe, expect, it } from "bun:test";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ok } from "../../../src/result";
import { MigrationService, type MigrationOutput } from "../../../src/marketplace/migration/migration-service";
import { MigrationPipeline, type ProgressCallback } from "../../../src/marketplace/migration/pipeline";

const tempPaths = new Set<string>();

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.add(dir);
  return dir;
}

async function createSourceSkillDir(content: string): Promise<string> {
  const sourceDir = await createTempDir("reins-migration-source-");
  await writeFile(join(sourceDir, "SKILL.md"), content, "utf8");
  return sourceDir;
}

function buildOpenClawSkill(): string {
  return `---
name: openclaw-calendar
description: OpenClaw calendar helper
version: 1.0.0
metadata:
  openclaw:
    requires:
      env:
        - OPENAI_API_KEY
---

# Calendar

Run sync tasks.
`;
}

function createMockMigrationService(output: MigrationOutput): Pick<MigrationService, "convert"> {
  return {
    convert: async () => ok(output),
  };
}

function extractStagingPath(message: string): string | null {
  const match = message.match(/at (.+?):/);
  return match?.[1] ?? null;
}

afterEach(async () => {
  const cleanupPromises: Promise<void>[] = [];
  for (const path of tempPaths) {
    cleanupPromises.push(rm(path, { recursive: true, force: true }));
  }
  await Promise.all(cleanupPromises);
  tempPaths.clear();
});

describe("MigrationPipeline", () => {
  it("migrates, stages, validates, and writes files to target directory", async () => {
    const sourceDir = await createSourceSkillDir(buildOpenClawSkill());
    const targetDir = join(await createTempDir("reins-migration-target-"), "nested", "skill");
    const progressSteps: string[] = [];

    const output: MigrationOutput = {
      skillMd: `---
name: migrated-calendar
description: Migrated calendar helper
version: 2.0.0
---

# Migrated
`,
      integrationMd: "# INTEGRATION.md\n\nFollow these steps.\n",
      report: {
        warnings: [],
        mappedFields: ["metadata.openclaw.requires.env -> config.envVars"],
        unmappedFields: [],
        usedLlm: true,
      },
    };

    const pipeline = new MigrationPipeline({
      migrationService: createMockMigrationService(output),
      onProgress: (step) => progressSteps.push(step),
    });

    const result = await pipeline.migrate(sourceDir, targetDir);

    expect(result.ok).toBe(true);
    expect(progressSteps).toEqual(["parsing", "converting", "generating", "validating", "complete"]);

    const targetSkill = await readFile(join(targetDir, "SKILL.md"), "utf8");
    const targetIntegration = await readFile(join(targetDir, "INTEGRATION.md"), "utf8");
    expect(targetSkill).toContain("name: migrated-calendar");
    expect(targetIntegration).toContain("Follow these steps.");
  });

  it("uses deterministic fallback output when LLM conversion fails", async () => {
    const sourceDir = await createSourceSkillDir(buildOpenClawSkill());
    const targetDir = await createTempDir("reins-migration-target-");

    const migrationService = new MigrationService({
      chatFn: async () => {
        throw new Error("provider unavailable");
      },
    });

    const pipeline = new MigrationPipeline({ migrationService });
    const result = await pipeline.migrate(sourceDir, targetDir);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.report.usedLlm).toBe(false);
    expect(result.value.skillMd).toContain("trustLevel: community");
    expect(result.value.report.warnings[0]).toContain("LLM call failed");

    const targetSkill = await readFile(join(targetDir, "SKILL.md"), "utf8");
    expect(targetSkill).toContain("trustLevel: community");
  });

  it("returns parsing error when source SKILL.md is missing", async () => {
    const sourceDir = await createTempDir("reins-migration-source-");
    const targetDir = await createTempDir("reins-migration-target-");
    const progressSteps: string[] = [];

    const pipeline = new MigrationPipeline({
      migrationService: createMockMigrationService({
        skillMd: "---\nname: should-not-run\ndescription: should-not-run\nversion: 0.0.1\n---\n",
        integrationMd: null,
        report: { warnings: [], mappedFields: [], unmappedFields: [], usedLlm: true },
      }),
      onProgress: (step) => progressSteps.push(step),
    });

    const result = await pipeline.migrate(sourceDir, targetDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Failed to read source SKILL.md");
    }
    expect(progressSteps).toEqual(["parsing", "failed"]);
  });

  it("returns validation error with staging path and keeps staged files", async () => {
    const sourceDir = await createSourceSkillDir(buildOpenClawSkill());
    const targetDir = await createTempDir("reins-migration-target-");
    const progressSteps: string[] = [];

    const pipeline = new MigrationPipeline({
      migrationService: createMockMigrationService({
        skillMd: `---
name: invalid-skill
description: Missing version value
---

# Invalid
`,
        integrationMd: null,
        report: {
          warnings: ["deterministic conversion warning"],
          mappedFields: [],
          unmappedFields: [],
          usedLlm: false,
        },
      }),
      onProgress: (step) => progressSteps.push(step),
    });

    const result = await pipeline.migrate(sourceDir, targetDir);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Validation failed for staged migration");
      expect(result.error.message).toContain("Warnings: deterministic conversion warning");

      const stagingPath = extractStagingPath(result.error.message);
      expect(stagingPath).not.toBeNull();
      if (stagingPath) {
        const stagedSkill = await readFile(join(stagingPath, "SKILL.md"), "utf8");
        expect(stagedSkill).toContain("name: invalid-skill");
      }
    }

    expect(progressSteps).toEqual(["parsing", "converting", "generating", "validating", "failed"]);
  });

  it("emits progress steps in order and creates missing target directory", async () => {
    const sourceDir = await createSourceSkillDir(buildOpenClawSkill());
    const targetRoot = await createTempDir("reins-migration-target-");
    const targetDir = join(targetRoot, "does", "not", "exist", "yet");

    const steps: Array<{ step: string; message: string }> = [];
    const onProgress: ProgressCallback = (step, message) => {
      steps.push({ step, message });
    };

    const pipeline = new MigrationPipeline({
      migrationService: createMockMigrationService({
        skillMd: `---
name: valid-skill
description: Valid
version: 1.0.0
---

# Valid
`,
        integrationMd: null,
        report: { warnings: [], mappedFields: [], unmappedFields: [], usedLlm: true },
      }),
      onProgress,
    });

    const result = await pipeline.migrate(sourceDir, targetDir);
    expect(result.ok).toBe(true);

    expect(steps.map((item) => item.step)).toEqual([
      "parsing",
      "converting",
      "generating",
      "validating",
      "complete",
    ]);

    await access(targetDir);
    const stagedSkill = await readFile(join(targetDir, "SKILL.md"), "utf8");
    expect(stagedSkill).toContain("version: 1.0.0");
  });

  it("writes INTEGRATION.md when conversion output includes integration content", async () => {
    const sourceDir = await createSourceSkillDir(buildOpenClawSkill());
    const targetDir = await createTempDir("reins-migration-target-");

    const pipeline = new MigrationPipeline({
      migrationService: createMockMigrationService({
        skillMd: `---
name: integration-skill
description: Includes integration
version: 1.0.0
---

# Integration Skill
`,
        integrationMd: "# INTEGRATION.md\n\n- export API_KEY\n",
        report: { warnings: [], mappedFields: [], unmappedFields: [], usedLlm: true },
      }),
    });

    const result = await pipeline.migrate(sourceDir, targetDir);
    expect(result.ok).toBe(true);

    const integration = await readFile(join(targetDir, "INTEGRATION.md"), "utf8");
    expect(integration).toContain("export API_KEY");
  });
});
