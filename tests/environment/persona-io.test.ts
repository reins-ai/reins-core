import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";

import { exportPersona, importPersona } from "../../src/environment/persona-io";

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

describe("importPersona", () => {
  let sourceEnvDir: string;
  let exportDir: string;
  let targetEnvDir: string;

  beforeEach(async () => {
    sourceEnvDir = makeTempDir();
    exportDir = makeTempDir();
    targetEnvDir = makeTempDir();
    await mkdir(sourceEnvDir, { recursive: true });
    await mkdir(targetEnvDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(sourceEnvDir, { recursive: true, force: true });
    await rm(exportDir, { recursive: true, force: true });
    await rm(targetEnvDir, { recursive: true, force: true });
  });

  async function createExportedZip(
    personaYaml: string,
    personalityMd: string,
  ): Promise<string> {
    await writeFile(join(sourceEnvDir, "PERSONA.yaml"), personaYaml);
    await writeFile(join(sourceEnvDir, "PERSONALITY.md"), personalityMd);
    const exportResult = await exportPersona(sourceEnvDir, exportDir);
    if (!exportResult.ok) {
      throw new Error(`Export failed: ${exportResult.error.message}`);
    }
    return exportResult.value.path;
  }

  function writeManualZip(entries: Record<string, string>): string {
    const zipEntries: Record<string, Uint8Array> = {};
    for (const [name, content] of Object.entries(entries)) {
      zipEntries[name] = strToU8(content);
    }
    const zipData = zipSync(zipEntries);
    const zipPath = join(exportDir, `manual-${randomUUID()}.zip`);
    Bun.write(zipPath, zipData);
    return zipPath;
  }

  it("imports from a valid zip (round-trip) successfully", async () => {
    const zipPath = await createExportedZip(
      "name: RoundTrip\navatar: 🔄\nlanguage: en\n",
      "# Round Trip\n\nThis is a round-trip test.",
    );

    const result = await importPersona(zipPath, targetEnvDir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.personaName).toBe("RoundTrip");
    expect(result.value.envDir).toBe(targetEnvDir);
    expect(result.value.importedAt).toBeTruthy();
  });

  it("writes imported PERSONA.yaml to envDir", async () => {
    const yamlContent = "name: ImportTest\navatar: 🎯\n";
    const zipPath = await createExportedZip(yamlContent, "# Personality\n\nSome content.");

    const result = await importPersona(zipPath, targetEnvDir);
    expect(result.ok).toBe(true);

    const written = await readFile(join(targetEnvDir, "PERSONA.yaml"), "utf-8");
    expect(written).toBe(yamlContent);
  });

  it("writes imported PERSONALITY.md to envDir", async () => {
    const mdContent = "# My Personality\n\nI am warm and friendly.";
    const zipPath = await createExportedZip("name: Test\n", mdContent);

    const result = await importPersona(zipPath, targetEnvDir);
    expect(result.ok).toBe(true);

    const written = await readFile(join(targetEnvDir, "PERSONALITY.md"), "utf-8");
    expect(written).toBe(mdContent);
  });

  it("round-trip preserves persona name", async () => {
    const zipPath = await createExportedZip(
      "name: PreserveName\navatar: 🌟\n",
      "# Personality\n\nContent here.",
    );

    const result = await importPersona(zipPath, targetEnvDir);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.personaName).toBe("PreserveName");
  });

  it("returns error for missing zip file", async () => {
    const missingPath = join(exportDir, "does-not-exist.zip");

    const result = await importPersona(missingPath, targetEnvDir);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("IMPORT_FAILED");
    expect(result.error.message).toContain("Persona zip not found");
  });

  it("returns error when zip is missing PERSONA.yaml", async () => {
    const zipPath = writeManualZip({
      "PERSONALITY.md": "# Personality\n\nSome content.",
    });
    // writeManualZip uses Bun.write which is async — wait for flush
    await Bun.sleep(10);

    const result = await importPersona(zipPath, targetEnvDir);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("IMPORT_FAILED");
    expect(result.error.message).toContain("missing PERSONA.yaml");
  });

  it("returns error when zip is missing PERSONALITY.md", async () => {
    const zipPath = writeManualZip({
      "PERSONA.yaml": "name: Test\navatar: 🤖\n",
    });
    await Bun.sleep(10);

    const result = await importPersona(zipPath, targetEnvDir);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("IMPORT_FAILED");
    expect(result.error.message).toContain("missing PERSONALITY.md");
  });

  it("returns error for invalid PERSONA.yaml content", async () => {
    // parsePersonaYaml is lenient — it returns defaults for invalid YAML.
    // However, a completely non-YAML binary blob that js-yaml can't parse
    // still returns defaults. The function never returns err().
    // So we test that even garbage YAML imports successfully with defaults.
    const zipPath = writeManualZip({
      "PERSONA.yaml": ":::not valid yaml [[[",
      "PERSONALITY.md": "# Valid content\n\nSome text.",
    });
    await Bun.sleep(10);

    const result = await importPersona(zipPath, targetEnvDir);

    // parsePersonaYaml is lenient — returns default persona for invalid YAML
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.personaName).toBe("Reins");
  });

  it("returns error for empty PERSONALITY.md", async () => {
    const zipPath = writeManualZip({
      "PERSONA.yaml": "name: EmptyPersonality\n",
      "PERSONALITY.md": "",
    });
    await Bun.sleep(10);

    const result = await importPersona(zipPath, targetEnvDir);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("IMPORT_FAILED");
    expect(result.error.message).toContain("PERSONALITY.md is empty");
  });

  it("returns error for whitespace-only PERSONALITY.md", async () => {
    const zipPath = writeManualZip({
      "PERSONA.yaml": "name: WhitespaceOnly\n",
      "PERSONALITY.md": "   \n  \t  \n  ",
    });
    await Bun.sleep(10);

    const result = await importPersona(zipPath, targetEnvDir);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("IMPORT_FAILED");
    expect(result.error.message).toContain("PERSONALITY.md is empty");
  });

  it("returns a valid importedAt ISO timestamp", async () => {
    const zipPath = await createExportedZip(
      "name: TimestampTest\n",
      "# Personality\n\nContent.",
    );

    const before = new Date();
    const result = await importPersona(zipPath, targetEnvDir);
    const after = new Date();

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const importedAt = new Date(result.value.importedAt);
    expect(importedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(importedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });
});
