import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";

import { SkillInstaller } from "../../../src/marketplace/install/installer";
import type { InstallStep } from "../../../src/marketplace/install/types";
import {
  cleanupTempPaths,
  createFailingMockMigrationPipeline,
  createFailingMockSource,
  createMockMigrationPipeline,
  createMockSource,
  createMockSourceWithZip,
  createTempDir,
  createZipFromFiles,
  INTEGRATION_MD_NO_SETUP,
  INTEGRATION_MD_WITH_SETUP,
  INVALID_NATIVE_SKILL_MD,
  NATIVE_SKILL_MD,
  NATIVE_SKILL_MD_NO_VERSION,
  NO_FRONTMATTER_SKILL_MD,
  OPENCLAW_SKILL_MD,
  OPENCLAW_SKILL_MD_NO_VERSION,
  tempPaths,
} from "./fixtures";

let skillsDir: string;

beforeEach(async () => {
  skillsDir = await createTempDir("reins-test-skills-");
});

afterEach(async () => {
  await cleanupTempPaths();
});

/**
 * Extracts the `reins-skill-*` temp root from an extractedPath so we can
 * clean it up without accidentally resolving to `/tmp` itself.
 */
function extractionTempRoot(extractedPath: string): string {
  const resolved = resolve(extractedPath);
  const tmp = resolve(tmpdir());
  const relative = resolved.slice(tmp.length + 1);
  const topDir = relative.split("/")[0];
  return topDir ? resolve(tmp, topDir) : resolved;
}

describe("SkillInstaller", () => {
  describe("successful Reins-native install", () => {
    it("downloads, extracts, validates, and installs a native skill", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD, {
        "README.md": "# Calendar Sync\n",
      });
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("smart-calendar-sync", "2.4.1");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.slug).toBe("smart-calendar-sync");
      expect(result.value.version).toBe("2.4.1");
      expect(result.value.migrated).toBe(false);
      expect(result.value.migrationReport).toBeUndefined();
      expect(result.value.installedPath).toContain("smart-calendar-sync");

      // Verify the SKILL.md was actually copied to the install directory
      const installedSkillMd = await readFile(
        resolve(result.value.installedPath, "SKILL.md"),
        "utf8",
      );
      expect(installedSkillMd).toContain("smart-calendar-sync");
    });

    it("installs to the correct subdirectory under skillsDir", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("smart-calendar-sync", "2.4.1");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.installedPath).toBe(
        resolve(skillsDir, "smart-calendar-sync"),
      );
    });
  });

  describe("ClawHub compatibility: version-less SKILL.md", () => {
    it("installs a native skill without version and injects API-provided version", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD_NO_VERSION);
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("smart-calendar-sync", "3.1.0");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.slug).toBe("smart-calendar-sync");
      expect(result.value.version).toBe("3.1.0");
      expect(result.value.migrated).toBe(false);

      // Verify the installed SKILL.md contains the injected version
      const installedSkillMd = await readFile(
        resolve(result.value.installedPath, "SKILL.md"),
        "utf8",
      );
      expect(installedSkillMd).toContain("version: 3.1.0");
      expect(installedSkillMd).toContain("name: smart-calendar-sync");
    });

    it("preserves explicit version when source SKILL.md already has one", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("smart-calendar-sync", "9.9.9");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // The installed SKILL.md should keep the original version (2.4.1), not the API version
      const installedSkillMd = await readFile(
        resolve(result.value.installedPath, "SKILL.md"),
        "utf8",
      );
      expect(installedSkillMd).toContain("version: 2.4.1");
      expect(installedSkillMd).not.toContain("version: 9.9.9");
    });

    it("installs an OpenClaw skill without version via migration with fallback", async () => {
      const source = await createMockSourceWithZip(OPENCLAW_SKILL_MD_NO_VERSION);
      const { pipeline, state } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("git-commit-assistant", "2.0.0");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.migrated).toBe(true);
      expect(result.value.slug).toBe("git-commit-assistant");
      expect(result.value.version).toBe("2.0.0");
      expect(state.migrateCalls.length).toBe(1);
    });
  });

  describe("successful OpenClaw install with migration", () => {
    it("detects OpenClaw metadata and triggers migration pipeline", async () => {
      const source = await createMockSourceWithZip(OPENCLAW_SKILL_MD);
      const { pipeline, state } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("git-commit-assistant", "1.8.0");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.migrated).toBe(true);
      expect(result.value.slug).toBe("git-commit-assistant");
      expect(result.value.version).toBe("1.8.0");

      // Verify migration pipeline was called
      expect(state.migrateCalls.length).toBe(1);
      expect(state.migrateCalls[0].targetDir).toBe(
        resolve(skillsDir, "git-commit-assistant"),
      );
    });

    it("includes migration report in the result", async () => {
      const source = await createMockSourceWithZip(OPENCLAW_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("git-commit-assistant", "1.8.0");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.migrationReport).toBeDefined();
      expect(result.value.migrationReport?.mappedFields).toContain("name");
      expect(result.value.migrationReport?.usedLlm).toBe(false);
    });

    it("writes migrated SKILL.md to the install directory", async () => {
      const source = await createMockSourceWithZip(OPENCLAW_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("git-commit-assistant", "1.8.0");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const installedSkillMd = await readFile(
        resolve(result.value.installedPath, "SKILL.md"),
        "utf8",
      );
      // The migrated content should be the mock pipeline's output, not the original
      expect(installedSkillMd).toContain("git-commit-assistant");
      expect(installedSkillMd).not.toContain("openclaw");
    });
  });

  describe("download failure", () => {
    it("returns error when source download fails", async () => {
      const source = createFailingMockSource("Connection timed out");
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("broken-skill", "1.0.0");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("Failed to download");
      expect(result.error.message).toContain("Connection timed out");
      expect(result.error.code).toBe("MARKETPLACE_DOWNLOAD_ERROR");
    });
  });

  describe("extraction failure", () => {
    it("returns error when zip data is corrupt", async () => {
      const corruptBuffer = new Uint8Array([0x50, 0x4b, 0x00, 0x00, 0xff]);
      const source = createMockSource({
        downloadResponse: {
          ok: true,
          value: {
            buffer: corruptBuffer,
            filename: "corrupt.zip",
            size: corruptBuffer.length,
            contentType: "application/zip",
          },
        },
      });
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("corrupt-skill", "1.0.0");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("Failed to extract");
      expect(result.error.code).toBe("MARKETPLACE_DOWNLOAD_ERROR");
    });

    it("returns error when zip is empty", async () => {
      const emptyBuffer = new Uint8Array(0);
      const source = createMockSource({
        downloadResponse: {
          ok: true,
          value: {
            buffer: emptyBuffer,
            filename: "empty.zip",
            size: 0,
            contentType: "application/zip",
          },
        },
      });
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("empty-skill", "1.0.0");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("Failed to extract");
      expect(result.error.code).toBe("MARKETPLACE_DOWNLOAD_ERROR");
    });
  });

  describe("migration failure", () => {
    it("returns error when migration pipeline fails", async () => {
      const source = await createMockSourceWithZip(OPENCLAW_SKILL_MD);
      const { pipeline } = createFailingMockMigrationPipeline(
        "Deterministic mapper could not parse frontmatter",
      );

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("git-commit-assistant", "1.8.0");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("Failed to migrate");
      expect(result.error.message).toContain("Deterministic mapper could not parse frontmatter");
      expect(result.error.code).toBe("MARKETPLACE_SOURCE_ERROR");
    });

    it("does not call migration pipeline for native skills", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD);
      const { pipeline, state } = createFailingMockMigrationPipeline(
        "Should not be called",
      );

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("smart-calendar-sync", "2.4.1");

      expect(result.ok).toBe(true);
      expect(state.migrateCalls.length).toBe(0);
    });
  });

  describe("validation failure", () => {
    it("returns error when native skill has missing required fields", async () => {
      const source = await createMockSourceWithZip(INVALID_NATIVE_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("incomplete-skill", "1.0.0");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("Validation failed");
      expect(result.error.message).toContain("Missing required frontmatter field: name");
      expect(result.error.code).toBe("MARKETPLACE_INVALID_RESPONSE");
    });

    it("returns error when native skill has no frontmatter", async () => {
      const source = await createMockSourceWithZip(NO_FRONTMATTER_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("no-frontmatter-skill", "1.0.0");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toContain("Validation failed");
      expect(result.error.message).toContain("frontmatter");
      expect(result.error.code).toBe("MARKETPLACE_INVALID_RESPONSE");
    });
  });

  describe("progress events", () => {
    it("emits all steps in correct order for native skill install", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();
      const steps: Array<{ step: InstallStep; message: string }> = [];

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
        onProgress: (step, message) => steps.push({ step, message }),
      });

      const result = await installer.install("smart-calendar-sync", "2.4.1");

      expect(result.ok).toBe(true);

      const stepNames = steps.map((s) => s.step);
      expect(stepNames).toEqual([
        "downloading",
        "extracting",
        "detecting",
        "validating",
        "installing",
        "installing",
        "complete",
      ]);

      // Verify messages contain relevant context
      expect(steps[0].message).toContain("smart-calendar-sync");
      expect(steps[0].message).toContain("Mock Source");
      expect(steps[stepNames.length - 1].message).toContain("successfully");
    });

    it("emits migration step for OpenClaw skill install", async () => {
      const source = await createMockSourceWithZip(OPENCLAW_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();
      const steps: Array<{ step: InstallStep; message: string }> = [];

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
        onProgress: (step, message) => steps.push({ step, message }),
      });

      const result = await installer.install("git-commit-assistant", "1.8.0");

      expect(result.ok).toBe(true);

      const stepNames = steps.map((s) => s.step);
      expect(stepNames).toEqual([
        "downloading",
        "extracting",
        "detecting",
        "migrating",
        "installing",
        "complete",
      ]);

      // Verify migration step mentions OpenClaw
      const migratingStep = steps.find((s) => s.step === "migrating");
      expect(migratingStep).toBeDefined();
      expect(migratingStep!.message).toContain("OpenClaw");
    });

    it("emits failed step when download fails", async () => {
      const source = createFailingMockSource("Network unreachable");
      const { pipeline } = createMockMigrationPipeline();
      const steps: Array<{ step: InstallStep; message: string }> = [];

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
        onProgress: (step, message) => steps.push({ step, message }),
      });

      await installer.install("broken-skill", "1.0.0");

      const stepNames = steps.map((s) => s.step);
      expect(stepNames).toContain("downloading");
      expect(stepNames).toContain("failed");
      expect(stepNames).not.toContain("complete");
    });

    it("emits failed step when validation fails", async () => {
      const source = await createMockSourceWithZip(INVALID_NATIVE_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();
      const steps: Array<{ step: InstallStep; message: string }> = [];

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
        onProgress: (step, message) => steps.push({ step, message }),
      });

      await installer.install("invalid-skill", "1.0.0");

      const stepNames = steps.map((s) => s.step);
      expect(stepNames).toContain("validating");
      expect(stepNames).toContain("failed");
      expect(stepNames).not.toContain("complete");
    });

    it("emits failed step when migration fails", async () => {
      const source = await createMockSourceWithZip(OPENCLAW_SKILL_MD);
      const { pipeline } = createFailingMockMigrationPipeline("Migration error");
      const steps: Array<{ step: InstallStep; message: string }> = [];

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
        onProgress: (step, message) => steps.push({ step, message }),
      });

      await installer.install("git-commit-assistant", "1.8.0");

      const stepNames = steps.map((s) => s.step);
      expect(stepNames).toContain("migrating");
      expect(stepNames).toContain("failed");
      expect(stepNames).not.toContain("complete");
    });
  });

  describe("edge cases", () => {
    it("handles zip wrapped in a top-level directory", async () => {
      const zipBuffer = await createZipFromFiles(
        { "SKILL.md": NATIVE_SKILL_MD, "README.md": "# Readme\n" },
        { wrapInDir: "skill-package-v1" },
      );
      const source = createMockSource({
        downloadResponse: {
          ok: true,
          value: {
            buffer: zipBuffer,
            filename: "wrapped.zip",
            size: zipBuffer.length,
            contentType: "application/zip",
          },
        },
      });
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("wrapped-skill", "1.0.0");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.migrated).toBe(false);

      // Verify the SKILL.md was installed correctly despite wrapper dir
      const installedSkillMd = await readFile(
        resolve(result.value.installedPath, "SKILL.md"),
        "utf8",
      );
      expect(installedSkillMd).toContain("smart-calendar-sync");
    });

    it("cleans up existing install directory before installing", async () => {
      // First install
      const source1 = await createMockSourceWithZip(NATIVE_SKILL_MD);
      const { pipeline: pipeline1 } = createMockMigrationPipeline();

      const installer1 = new SkillInstaller({
        source: source1,
        migrationPipeline: pipeline1,
        skillsDir,
      });

      const result1 = await installer1.install("smart-calendar-sync", "2.4.0");
      expect(result1.ok).toBe(true);

      // Second install to same slug (upgrade)
      const updatedSkillMd = NATIVE_SKILL_MD.replace("2.4.1", "2.5.0");
      const source2 = await createMockSourceWithZip(updatedSkillMd);
      const { pipeline: pipeline2 } = createMockMigrationPipeline();

      const installer2 = new SkillInstaller({
        source: source2,
        migrationPipeline: pipeline2,
        skillsDir,
      });

      const result2 = await installer2.install("smart-calendar-sync", "2.5.0");

      expect(result2.ok).toBe(true);
      if (!result2.ok) return;

      expect(result2.value.version).toBe("2.5.0");
    });
  });

  describe("integration guide surfacing", () => {
    it("returns integration info when native skill includes INTEGRATION.md", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD, {
        "INTEGRATION.md": INTEGRATION_MD_WITH_SETUP,
      });
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("smart-calendar-sync", "2.4.1");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.integration).toBeDefined();
      expect(result.value.integration!.setupRequired).toBe(true);
      expect(result.value.integration!.guidePath).toContain("INTEGRATION.md");
      expect(result.value.integration!.sections.length).toBeGreaterThan(0);

      const sectionTitles = result.value.integration!.sections.map((s) => s.title);
      expect(sectionTitles).toContain("Setup");
      expect(sectionTitles).toContain("Configuration");
    });

    it("returns integration info when migrated skill produces INTEGRATION.md", async () => {
      const source = await createMockSourceWithZip(OPENCLAW_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline({
        integrationMd: INTEGRATION_MD_WITH_SETUP,
      });

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("git-commit-assistant", "1.8.0");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.migrated).toBe(true);
      expect(result.value.integration).toBeDefined();
      expect(result.value.integration!.setupRequired).toBe(true);
      expect(result.value.integration!.guidePath).toContain("INTEGRATION.md");
      expect(result.value.integration!.sections.length).toBeGreaterThan(0);
    });

    it("omits integration when no INTEGRATION.md exists", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("smart-calendar-sync", "2.4.1");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.integration).toBeUndefined();
    });

    it("omits integration when migrated skill has no INTEGRATION.md", async () => {
      const source = await createMockSourceWithZip(OPENCLAW_SKILL_MD);
      const { pipeline } = createMockMigrationPipeline({ integrationMd: null });

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("git-commit-assistant", "1.8.0");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.migrated).toBe(true);
      expect(result.value.integration).toBeUndefined();
    });

    it("marks setupRequired false when INTEGRATION.md has no setup steps", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD, {
        "INTEGRATION.md": INTEGRATION_MD_NO_SETUP,
      });
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("smart-calendar-sync", "2.4.1");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.integration).toBeDefined();
      expect(result.value.integration!.setupRequired).toBe(false);
      expect(result.value.integration!.sections.length).toBeGreaterThan(0);
    });

    it("provides absolute guidePath pointing to installed directory", async () => {
      const source = await createMockSourceWithZip(NATIVE_SKILL_MD, {
        "INTEGRATION.md": INTEGRATION_MD_WITH_SETUP,
      });
      const { pipeline } = createMockMigrationPipeline();

      const installer = new SkillInstaller({
        source,
        migrationPipeline: pipeline,
        skillsDir,
      });

      const result = await installer.install("smart-calendar-sync", "2.4.1");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.integration!.guidePath).toBe(
        resolve(result.value.installedPath, "INTEGRATION.md"),
      );
    });
  });
});
