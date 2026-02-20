import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";

import { exportPersona } from "../../src/environment/persona-io";

function makeTempDir(): string {
  return join(tmpdir(), `persona-io-test-${randomUUID()}`);
}

describe("exportPersona", () => {
  let envDir: string;
  let outputDir: string;

  beforeEach(async () => {
    envDir = makeTempDir();
    outputDir = makeTempDir();
    await mkdir(envDir, { recursive: true });
    // outputDir is created by exportPersona itself
  });

  afterEach(async () => {
    await rm(envDir, { recursive: true, force: true });
    await rm(outputDir, { recursive: true, force: true });
  });

  it("creates a zip file at the expected path", async () => {
    await writeFile(join(envDir, "PERSONA.yaml"), "name: TestBot\navatar: 🐱\n");
    await writeFile(join(envDir, "PERSONALITY.md"), "# Personality\nBe helpful.");

    const result = await exportPersona(envDir, outputDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const file = Bun.file(result.value.path);
    expect(await file.exists()).toBe(true);
    expect(file.size).toBeGreaterThan(0);
  });

  it("exported zip contains PERSONA.yaml", async () => {
    const yamlContent = "name: ExportTest\navatar: 🎭\nlanguage: en\n";
    await writeFile(join(envDir, "PERSONA.yaml"), yamlContent);
    await writeFile(join(envDir, "PERSONALITY.md"), "");

    const result = await exportPersona(envDir, outputDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const zipBytes = await Bun.file(result.value.path).arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(zipBytes));

    expect(unzipped["PERSONA.yaml"]).toBeDefined();
    expect(strFromU8(unzipped["PERSONA.yaml"])).toBe(yamlContent);
  });

  it("exported zip contains PERSONALITY.md", async () => {
    const mdContent = "# My Personality\n\nI am warm and friendly.";
    await writeFile(join(envDir, "PERSONA.yaml"), "name: Test\n");
    await writeFile(join(envDir, "PERSONALITY.md"), mdContent);

    const result = await exportPersona(envDir, outputDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const zipBytes = await Bun.file(result.value.path).arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(zipBytes));

    expect(unzipped["PERSONALITY.md"]).toBeDefined();
    expect(strFromU8(unzipped["PERSONALITY.md"])).toBe(mdContent);
  });

  it("filename follows persona-{timestamp}.zip pattern", async () => {
    await writeFile(join(envDir, "PERSONA.yaml"), "name: Test\n");

    const result = await exportPersona(envDir, outputDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const filename = result.value.path.split("/").pop()!;
    expect(filename).toMatch(/^persona-\d{4}-\d{2}-\d{2}-\d{4}\.zip$/);
  });

  it("handles missing PERSONA.yaml gracefully with default content", async () => {
    // No PERSONA.yaml written — should use default
    await writeFile(join(envDir, "PERSONALITY.md"), "# Personality");

    const result = await exportPersona(envDir, outputDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const zipBytes = await Bun.file(result.value.path).arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(zipBytes));

    const yamlContent = strFromU8(unzipped["PERSONA.yaml"]);
    expect(yamlContent).toContain("name: Reins");
    expect(yamlContent).toContain("avatar:");
  });

  it("handles missing PERSONALITY.md gracefully with empty string", async () => {
    // No PERSONALITY.md written — should use empty string
    await writeFile(join(envDir, "PERSONA.yaml"), "name: Test\n");

    const result = await exportPersona(envDir, outputDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const zipBytes = await Bun.file(result.value.path).arrayBuffer();
    const unzipped = unzipSync(new Uint8Array(zipBytes));

    expect(strFromU8(unzipped["PERSONALITY.md"])).toBe("");
  });

  it("returns error result for invalid output directory", async () => {
    await writeFile(join(envDir, "PERSONA.yaml"), "name: Test\n");

    // Use a path that cannot be created (file as parent)
    const blockerFile = join(outputDir, "blocker");
    await mkdir(outputDir, { recursive: true });
    await writeFile(blockerFile, "not a directory");
    const invalidOutputDir = join(blockerFile, "nested", "path");

    const result = await exportPersona(envDir, invalidOutputDir);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("EXPORT_FAILED");
    expect(result.error.message).toContain("Failed to export persona");
  });

  it("returns a valid exportedAt ISO timestamp", async () => {
    await writeFile(join(envDir, "PERSONA.yaml"), "name: Test\n");

    const before = new Date();
    const result = await exportPersona(envDir, outputDir);
    const after = new Date();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const exportedAt = new Date(result.value.exportedAt);
    expect(exportedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(exportedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("creates the output directory if it does not exist", async () => {
    await writeFile(join(envDir, "PERSONA.yaml"), "name: Test\n");

    const nestedOutput = join(outputDir, "deep", "nested");
    const result = await exportPersona(envDir, nestedOutput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const file = Bun.file(result.value.path);
    expect(await file.exists()).toBe(true);
  });
});
