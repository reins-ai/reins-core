import { describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { SharedRefMapper } from "../../../src/conversion/mappers/shared-ref-mapper";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTempDir(suffix: string): Promise<string> {
  const dir = join(
    "/tmp",
    `reins-test-shared-${suffix}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(dir, { recursive: true });
  return dir;
}

async function writeFixture(
  base: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = join(base, relativePath);
  const dir = join(fullPath, "..");
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, "utf8");
}

async function fileContent(path: string): Promise<string> {
  return Bun.file(path).text();
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SharedRefMapper", () => {
  it("copies shared-references files to target directory", async () => {
    const srcDir = await makeTempDir("src");
    const targetDir = await makeTempDir("target");

    try {
      const sharedRefSrc = join(srcDir, "shared-references");
      await writeFixture(sharedRefSrc, "guide.md", "# Guide");
      await writeFixture(sharedRefSrc, "nested/tips.md", "# Tips");

      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({ sharedReferences: sharedRefSrc });

      expect(result.converted).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      const guideContent = await fileContent(
        join(targetDir, "shared-references", "guide.md"),
      );
      expect(guideContent).toBe("# Guide");

      const tipsContent = await fileContent(
        join(targetDir, "shared-references", "nested", "tips.md"),
      );
      expect(tipsContent).toBe("# Tips");
    } finally {
      await rm(srcDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("copies templates files to target directory", async () => {
    const srcDir = await makeTempDir("src");
    const targetDir = await makeTempDir("target");

    try {
      const templatesSrc = join(srcDir, "templates");
      await writeFixture(templatesSrc, "base.md", "# Base Template");
      await writeFixture(templatesSrc, "sub/variant.md", "# Variant");

      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({ templates: templatesSrc });

      expect(result.converted).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      const baseContent = await fileContent(
        join(targetDir, "templates", "base.md"),
      );
      expect(baseContent).toBe("# Base Template");

      const variantContent = await fileContent(
        join(targetDir, "templates", "sub", "variant.md"),
      );
      expect(variantContent).toBe("# Variant");
    } finally {
      await rm(srcDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("copies both shared-references and templates in one call", async () => {
    const srcDir = await makeTempDir("src");
    const targetDir = await makeTempDir("target");

    try {
      const sharedRefSrc = join(srcDir, "shared-references");
      const templatesSrc = join(srcDir, "templates");

      await writeFixture(sharedRefSrc, "ref.md", "ref content");
      await writeFixture(templatesSrc, "tmpl.md", "tmpl content");

      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({
        sharedReferences: sharedRefSrc,
        templates: templatesSrc,
      });

      expect(result.converted).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      expect(
        await fileExists(join(targetDir, "shared-references", "ref.md")),
      ).toBe(true);
      expect(
        await fileExists(join(targetDir, "templates", "tmpl.md")),
      ).toBe(true);
    } finally {
      await rm(srcDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("skips gracefully when shared-references source directory is missing", async () => {
    const targetDir = await makeTempDir("target");

    try {
      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({
        sharedReferences: "/tmp/nonexistent-shared-refs-xyz",
      });

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(0);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("skips gracefully when templates source directory is missing", async () => {
    const targetDir = await makeTempDir("target");

    try {
      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({
        templates: "/tmp/nonexistent-templates-xyz",
      });

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(0);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("skips both when both source directories are missing", async () => {
    const targetDir = await makeTempDir("target");

    try {
      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({
        sharedReferences: "/tmp/nonexistent-shared-refs-xyz",
        templates: "/tmp/nonexistent-templates-xyz",
      });

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(2);
      expect(result.errors).toHaveLength(0);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("returns zero converted when no source paths are provided", async () => {
    const targetDir = await makeTempDir("target");

    try {
      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({});

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);
    } finally {
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("skips (not errors) an empty source directory", async () => {
    const srcDir = await makeTempDir("src");
    const targetDir = await makeTempDir("target");

    try {
      const sharedRefSrc = join(srcDir, "shared-references");
      await mkdir(sharedRefSrc, { recursive: true });

      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({ sharedReferences: sharedRefSrc });

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(1);
      expect(result.errors).toHaveLength(0);
    } finally {
      await rm(srcDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("preserves nested directory structure", async () => {
    const srcDir = await makeTempDir("src");
    const targetDir = await makeTempDir("target");

    try {
      const sharedRefSrc = join(srcDir, "shared-references");
      await writeFixture(sharedRefSrc, "a/b/c/deep.txt", "deep content");

      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({ sharedReferences: sharedRefSrc });

      expect(result.converted).toBe(1);
      expect(result.errors).toHaveLength(0);

      const content = await fileContent(
        join(targetDir, "shared-references", "a", "b", "c", "deep.txt"),
      );
      expect(content).toBe("deep content");
    } finally {
      await rm(srcDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("does not write files in dryRun mode", async () => {
    const srcDir = await makeTempDir("src");
    const targetDir = await makeTempDir("target");

    try {
      const sharedRefSrc = join(srcDir, "shared-references");
      await writeFixture(sharedRefSrc, "ref.md", "content");

      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map(
        { sharedReferences: sharedRefSrc },
        { dryRun: true },
      );

      expect(result.converted).toBe(1);
      expect(result.errors).toHaveLength(0);

      const destFile = join(targetDir, "shared-references", "ref.md");
      expect(await fileExists(destFile)).toBe(false);
    } finally {
      await rm(srcDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("reports progress via onProgress callback", async () => {
    const srcDir = await makeTempDir("src");
    const targetDir = await makeTempDir("target");

    try {
      const sharedRefSrc = join(srcDir, "shared-references");
      const templatesSrc = join(srcDir, "templates");
      await writeFixture(sharedRefSrc, "ref.md", "ref");
      await writeFixture(templatesSrc, "tmpl.md", "tmpl");

      const progressCalls: Array<[number, number]> = [];
      const mapper = new SharedRefMapper(targetDir);

      await mapper.map(
        { sharedReferences: sharedRefSrc, templates: templatesSrc },
        {
          onProgress: (processed, total) => {
            progressCalls.push([processed, total]);
          },
        },
      );

      expect(progressCalls).toHaveLength(2);
      expect(progressCalls[0]).toEqual([1, 2]);
      expect(progressCalls[1]).toEqual([2, 2]);
    } finally {
      await rm(srcDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });

  it("creates target directories that do not yet exist", async () => {
    const srcDir = await makeTempDir("src");
    const targetDir = join("/tmp", `reins-test-new-target-${Math.random().toString(36).slice(2)}`);

    try {
      const sharedRefSrc = join(srcDir, "shared-references");
      await writeFixture(sharedRefSrc, "file.md", "hello");

      const mapper = new SharedRefMapper(targetDir);
      const result = await mapper.map({ sharedReferences: sharedRefSrc });

      expect(result.converted).toBe(1);
      expect(result.errors).toHaveLength(0);

      const content = await fileContent(
        join(targetDir, "shared-references", "file.md"),
      );
      expect(content).toBe("hello");
    } finally {
      await rm(srcDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
  });
});
