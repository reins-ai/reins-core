import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { err, ok, type Result } from "../../../src/result";
import { MarketplaceError, MARKETPLACE_ERROR_CODES } from "../../../src/marketplace/errors";
import type { DownloadResult, MarketplaceSource } from "../../../src/marketplace/types";
import type { MigrationPipeline } from "../../../src/marketplace/migration/pipeline";
import type { MigrationReport, MigrationResult } from "../../../src/marketplace/migration/types";

/**
 * Tracks temp directories for cleanup in afterEach.
 */
export const tempPaths = new Set<string>();

export async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.add(dir);
  return dir;
}

export async function cleanupTempPaths(): Promise<void> {
  const cleanupPromises: Promise<void>[] = [];
  for (const path of tempPaths) {
    cleanupPromises.push(rm(path, { recursive: true, force: true }));
  }
  await Promise.all(cleanupPromises);
  tempPaths.clear();
}

// ---------------------------------------------------------------------------
// Sample SKILL.md content
// ---------------------------------------------------------------------------

/**
 * Valid Reins-native SKILL.md with required frontmatter fields.
 */
export const NATIVE_SKILL_MD = [
  "---",
  "name: smart-calendar-sync",
  "description: Bidirectional calendar synchronization",
  "version: 2.4.1",
  "author: openclaw",
  "categories:",
  "  - productivity",
  "  - calendar",
  "---",
  "",
  "# Smart Calendar Sync",
  "",
  "Syncs your calendars across providers.",
  "",
].join("\n");

/**
 * OpenClaw-format SKILL.md with nested metadata.openclaw block that
 * triggers the migration path in SkillInstaller.
 */
export const OPENCLAW_SKILL_MD = [
  "---",
  "name: git-commit-assistant",
  "description: AI-powered commit message generation",
  "version: 1.8.0",
  "author: devtools-collective",
  "metadata:",
  "  openclaw:",
  "    source: clawhub",
  "    original-format: openclaw-v2",
  "    requires:",
  "      bins:",
  "        - git",
  "---",
  "",
  "# Git Commit Assistant",
  "",
  "Generates commit messages from staged diffs.",
  "",
].join("\n");

/**
 * Valid Reins-native SKILL.md without a version field.
 * ClawHub skills may omit version in SKILL.md, providing it via API metadata.
 */
export const NATIVE_SKILL_MD_NO_VERSION = [
  "---",
  "name: smart-calendar-sync",
  "description: Bidirectional calendar synchronization",
  "author: openclaw",
  "categories:",
  "  - productivity",
  "  - calendar",
  "---",
  "",
  "# Smart Calendar Sync",
  "",
  "Syncs your calendars across providers.",
  "",
].join("\n");

/**
 * OpenClaw-format SKILL.md without a version field.
 * ClawHub skills may omit version in SKILL.md, providing it via API metadata.
 */
export const OPENCLAW_SKILL_MD_NO_VERSION = [
  "---",
  "name: git-commit-assistant",
  "description: AI-powered commit message generation",
  "author: devtools-collective",
  "metadata:",
  "  openclaw:",
  "    source: clawhub",
  "    original-format: openclaw-v2",
  "    requires:",
  "      bins:",
  "        - git",
  "---",
  "",
  "# Git Commit Assistant",
  "",
  "Generates commit messages from staged diffs.",
  "",
].join("\n");

/**
 * Invalid SKILL.md missing required frontmatter fields (no name).
 */
export const INVALID_NATIVE_SKILL_MD = [
  "---",
  "description: A skill with missing required fields",
  "---",
  "",
  "# Incomplete Skill",
  "",
].join("\n");

/**
 * Content that has no frontmatter delimiters at all.
 */
export const NO_FRONTMATTER_SKILL_MD = [
  "# Just Markdown",
  "",
  "No frontmatter here.",
  "",
].join("\n");

/**
 * Sample INTEGRATION.md content with setup steps.
 * Used to test that the installer surfaces integration info.
 */
export const INTEGRATION_MD_WITH_SETUP = [
  "# Integration Guide",
  "",
  "This skill requires the `summarize` CLI tool.",
  "",
  "## Setup",
  "",
  "1. Install summarize: `brew install summarize`",
  "2. Verify installation: `summarize --version`",
  "",
  "## Configuration",
  "",
  "Set the `SUMMARIZE_API_KEY` environment variable.",
  "",
].join("\n");

/**
 * Minimal INTEGRATION.md without setup steps.
 */
export const INTEGRATION_MD_NO_SETUP = [
  "# Notes",
  "",
  "This skill works out of the box with no additional setup.",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// Zip creation helper
// ---------------------------------------------------------------------------

/**
 * Creates a real zip file from a map of relative paths to file contents.
 * Uses the system `zip` command, matching the pattern in downloader.test.ts.
 */
export async function createZipFromFiles(
  files: Record<string, string>,
  options?: { wrapInDir?: string },
): Promise<Uint8Array> {
  const workDir = await createTempDir("reins-zip-build-");

  let fileDir = workDir;
  if (options?.wrapInDir) {
    fileDir = join(workDir, options.wrapInDir);
    await mkdir(fileDir, { recursive: true });
  }

  for (const [name, content] of Object.entries(files)) {
    const filePath = join(fileDir, name);
    const parentDir = join(filePath, "..");
    await mkdir(parentDir, { recursive: true });
    await writeFile(filePath, content, "utf8");
  }

  const zipPath = join(workDir, "output.zip");

  const filesToZip = options?.wrapInDir
    ? [options.wrapInDir]
    : Object.keys(files);

  const proc = Bun.spawn(["zip", "-r", zipPath, ...filesToZip], {
    cwd: workDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;

  const zipFile = Bun.file(zipPath);
  const buffer = await zipFile.arrayBuffer();
  return new Uint8Array(buffer);
}

// ---------------------------------------------------------------------------
// Mock MarketplaceSource
// ---------------------------------------------------------------------------

interface MockSourceOptions {
  downloadResponse?: Result<DownloadResult>;
}

/**
 * Creates a mock MarketplaceSource that returns configurable download results.
 * All other methods (browse, search, getDetail, getCategories) throw to ensure
 * they are not called during install tests.
 */
export function createMockSource(options: MockSourceOptions = {}): MarketplaceSource {
  const downloadResponse = options.downloadResponse ?? ok({
    buffer: new Uint8Array(0),
    filename: "skill.zip",
    size: 0,
    contentType: "application/zip",
  });

  return {
    id: "mock-source",
    name: "Mock Source",
    description: "Mock marketplace source for testing",
    browse: () => { throw new Error("browse should not be called during install"); },
    search: () => { throw new Error("search should not be called during install"); },
    getDetail: () => { throw new Error("getDetail should not be called during install"); },
    getCategories: () => { throw new Error("getCategories should not be called during install"); },
    download: async () => downloadResponse,
  };
}

/**
 * Creates a mock source whose download returns a real zip containing the given
 * SKILL.md content plus optional extra files.
 */
export async function createMockSourceWithZip(
  skillMdContent: string,
  extraFiles?: Record<string, string>,
): Promise<MarketplaceSource> {
  const files: Record<string, string> = {
    "SKILL.md": skillMdContent,
    ...extraFiles,
  };

  const zipBuffer = await createZipFromFiles(files);

  return createMockSource({
    downloadResponse: ok({
      buffer: zipBuffer,
      filename: "skill.zip",
      size: zipBuffer.length,
      contentType: "application/zip",
    }),
  });
}

/**
 * Creates a mock source whose download returns an error.
 */
export function createFailingMockSource(message: string): MarketplaceSource {
  return createMockSource({
    downloadResponse: err(
      new MarketplaceError(message, MARKETPLACE_ERROR_CODES.NETWORK_ERROR),
    ),
  });
}

// ---------------------------------------------------------------------------
// Mock MigrationPipeline
// ---------------------------------------------------------------------------

interface MockMigrationPipelineOptions {
  migrateResult?: Result<MigrationResult, MarketplaceError>;
  integrationMd?: string | null;
}

interface MockMigrationPipelineState {
  migrateCalls: Array<{ sourcePath: string; targetDir: string }>;
}

interface MockMigrationPipelineReturn {
  pipeline: MigrationPipeline;
  state: MockMigrationPipelineState;
}

const DEFAULT_MIGRATION_REPORT: MigrationReport = {
  warnings: [],
  mappedFields: ["name", "description", "version", "author"],
  unmappedFields: [],
  usedLlm: false,
};

const DEFAULT_MIGRATED_SKILL_MD = [
  "---",
  "name: git-commit-assistant",
  "description: AI-powered commit message generation",
  "version: 1.8.0",
  "author: devtools-collective",
  "---",
  "",
  "# Git Commit Assistant",
  "",
  "Generates commit messages from staged diffs.",
  "",
].join("\n");

/**
 * Creates a mock MigrationPipeline that captures calls and returns
 * configurable results. On success, it writes a valid SKILL.md to the
 * target directory so the installer's post-migration flow works correctly.
 */
export function createMockMigrationPipeline(
  options: MockMigrationPipelineOptions = {},
): MockMigrationPipelineReturn {
  const callState: MockMigrationPipelineState = {
    migrateCalls: [],
  };

  const integrationMd = options.integrationMd !== undefined
    ? options.integrationMd
    : null;

  const defaultResult: Result<MigrationResult, MarketplaceError> = ok({
    skillMd: DEFAULT_MIGRATED_SKILL_MD,
    integrationMd,
    report: DEFAULT_MIGRATION_REPORT,
  });

  const migrateResult = options.migrateResult ?? defaultResult;

  const pipeline = {
    migrate: async (sourcePath: string, targetDir: string) => {
      callState.migrateCalls.push({ sourcePath, targetDir });

      // When migration succeeds, write the migrated SKILL.md to targetDir
      // so the installer can read it for registration
      if (migrateResult.ok) {
        await mkdir(targetDir, { recursive: true });
        await writeFile(
          join(targetDir, "SKILL.md"),
          migrateResult.value.skillMd,
          "utf8",
        );
        if (migrateResult.value.integrationMd !== null) {
          await writeFile(
            join(targetDir, "INTEGRATION.md"),
            migrateResult.value.integrationMd,
            "utf8",
          );
        }
      }

      return migrateResult;
    },
  } as MigrationPipeline;

  return { pipeline, state: callState };
}

/**
 * Creates a mock MigrationPipeline that returns an error.
 */
export function createFailingMockMigrationPipeline(
  message: string,
): MockMigrationPipelineReturn {
  return createMockMigrationPipeline({
    migrateResult: err(
      new MarketplaceError(message, MARKETPLACE_ERROR_CODES.SOURCE_ERROR),
    ),
  });
}
