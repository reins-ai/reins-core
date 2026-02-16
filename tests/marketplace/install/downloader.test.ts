import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { downloadAndExtract, type ExtractionResult } from "../../../src/marketplace/install/downloader";
import type { DownloadResult } from "../../../src/marketplace/types";

const tempPaths = new Set<string>();

async function createTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempPaths.add(dir);
  return dir;
}

/**
 * Extracts the `reins-skill-*` temp root from an extractedPath so we can
 * clean it up without accidentally resolving to `/tmp` itself.
 */
function extractionTempRoot(extractedPath: string): string {
  const resolved = resolve(extractedPath);
  const tmp = resolve(tmpdir());
  const relative = resolved.slice(tmp.length + 1);
  const topDir = relative.split("/")[0];
  return join(tmp, topDir);
}

/**
 * Creates a real zip file from a directory of files using the system `zip` command.
 * Returns the zip contents as a Uint8Array suitable for DownloadResult.buffer.
 */
async function createZipFromFiles(
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

function makeDownloadResult(buffer: Uint8Array, filename = "skill.zip"): DownloadResult {
  return {
    buffer,
    filename,
    size: buffer.length,
    contentType: "application/zip",
  };
}

afterEach(async () => {
  const cleanupPromises: Promise<void>[] = [];
  for (const path of tempPaths) {
    cleanupPromises.push(rm(path, { recursive: true, force: true }));
  }
  await Promise.all(cleanupPromises);
  tempPaths.clear();
});

describe("downloadAndExtract", () => {
  it("extracts a valid zip containing SKILL.md at the root", async () => {
    const zipBuffer = await createZipFromFiles({
      "SKILL.md": "---\nname: test-skill\ndescription: A test\nversion: 1.0.0\n---\n\n# Test Skill\n",
      "README.md": "# README\n",
    });

    const result = await downloadAndExtract(makeDownloadResult(zipBuffer));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const value: ExtractionResult = result.value;
    expect(value.hasSkillMd).toBe(true);
    expect(value.files).toContain("SKILL.md");
    expect(value.files).toContain("README.md");
    expect(value.files.length).toBe(2);

    tempPaths.add(extractionTempRoot(value.extractedPath));
  });

  it("handles zip with a single top-level directory wrapping SKILL.md", async () => {
    const zipBuffer = await createZipFromFiles(
      {
        "SKILL.md": "---\nname: wrapped-skill\ndescription: Wrapped\nversion: 1.0.0\n---\n\n# Wrapped\n",
        "config.json": "{}",
      },
      { wrapInDir: "my-skill-v1" },
    );

    const result = await downloadAndExtract(makeDownloadResult(zipBuffer));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hasSkillMd).toBe(true);
    expect(result.value.files).toContain("SKILL.md");
    expect(result.value.files).toContain("config.json");
    // extractedPath should point to the inner directory, not the outer extraction root
    expect(result.value.extractedPath).toContain("my-skill-v1");

    tempPaths.add(extractionTempRoot(result.value.extractedPath));
  });

  it("returns error when extracted zip does not contain SKILL.md", async () => {
    const zipBuffer = await createZipFromFiles({
      "README.md": "# No skill here\n",
      "config.json": "{}",
    });

    const result = await downloadAndExtract(makeDownloadResult(zipBuffer));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.name).toBe("MarketplaceError");
    expect(result.error.code).toBe("MARKETPLACE_INVALID_RESPONSE");
    expect(result.error.message).toContain("SKILL.md");
  });

  it("returns error for an empty buffer", async () => {
    const emptyBuffer = new Uint8Array(0);

    const result = await downloadAndExtract(makeDownloadResult(emptyBuffer));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.name).toBe("MarketplaceError");
    expect(result.error.code).toBe("MARKETPLACE_DOWNLOAD_ERROR");
    expect(result.error.message).toContain("empty");
  });

  it("returns error for invalid zip data", async () => {
    const garbageBuffer = new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04]);

    const result = await downloadAndExtract(makeDownloadResult(garbageBuffer));

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.name).toBe("MarketplaceError");
    expect(result.error.code).toBe("MARKETPLACE_DOWNLOAD_ERROR");
    expect(result.error.message).toContain("Failed to extract");
  });

  it("returns correct file listing for multi-file zip", async () => {
    const zipBuffer = await createZipFromFiles({
      "SKILL.md": "---\nname: multi\ndescription: Multi-file\nversion: 1.0.0\n---\n\n# Multi\n",
      "INTEGRATION.md": "# Integration\n",
      "examples/basic.md": "# Basic example\n",
    });

    const result = await downloadAndExtract(makeDownloadResult(zipBuffer));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hasSkillMd).toBe(true);
    expect(result.value.files).toContain("SKILL.md");
    expect(result.value.files).toContain("INTEGRATION.md");
    expect(result.value.files).toContain("examples");

    tempPaths.add(extractionTempRoot(result.value.extractedPath));
  });

  it("accepts ArrayBuffer as well as Uint8Array", async () => {
    const zipBuffer = await createZipFromFiles({
      "SKILL.md": "---\nname: arraybuffer-test\ndescription: Test\nversion: 1.0.0\n---\n\n# AB\n",
    });

    // Convert to ArrayBuffer
    const arrayBuffer = zipBuffer.buffer.slice(
      zipBuffer.byteOffset,
      zipBuffer.byteOffset + zipBuffer.byteLength,
    );

    const downloadResult: DownloadResult = {
      buffer: arrayBuffer,
      filename: "skill.zip",
      size: arrayBuffer.byteLength,
      contentType: "application/zip",
    };

    const result = await downloadAndExtract(downloadResult);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hasSkillMd).toBe(true);

    tempPaths.add(extractionTempRoot(result.value.extractedPath));
  });

  it("finds SKILL.md in a nested subdirectory within a wrapper directory", async () => {
    const workDir = await createTempDir("reins-nested-zip-");
    const nestedDir = join(workDir, "wrapper", "inner");
    await mkdir(nestedDir, { recursive: true });
    await writeFile(
      join(nestedDir, "SKILL.md"),
      "---\nname: deeply-nested\ndescription: Deep\nversion: 1.0.0\n---\n\n# Deep\n",
    );
    await writeFile(join(workDir, "wrapper", "LICENSE"), "MIT");

    const zipPath = join(workDir, "nested.zip");
    const proc = Bun.spawn(["zip", "-r", zipPath, "wrapper"], {
      cwd: workDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const zipFile = Bun.file(zipPath);
    const buffer = new Uint8Array(await zipFile.arrayBuffer());

    const result = await downloadAndExtract(makeDownloadResult(buffer));

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.hasSkillMd).toBe(true);
    expect(result.value.files).toContain("SKILL.md");
    expect(result.value.extractedPath).toContain("inner");

    tempPaths.add(extractionTempRoot(result.value.extractedPath));
  });
});
