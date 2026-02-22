import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  SkillMapper,
  type PluginStubEntry,
  type SkillMapperFileOps,
} from "../../../src/conversion/mappers/skill-mapper";
import type { OpenClawSkillConfig } from "../../../src/conversion/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTmpOutputPath(): string {
  const id = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `reins-test-skill-mapper-${id}`, "plugins-imported.json");
}

function makeSkill(overrides: Partial<OpenClawSkillConfig> = {}): OpenClawSkillConfig {
  return {
    name: "test-skill",
    description: "A test skill",
    entryPoint: "./skills/test-skill/index.ts",
    version: "1.2.0",
    author: "Jane Doe",
    ...overrides,
  };
}

async function readStubs(path: string): Promise<PluginStubEntry[]> {
  const file = Bun.file(path);
  const text = await file.text();
  return JSON.parse(text) as PluginStubEntry[];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SkillMapper", () => {
  let outputPath: string;

  beforeEach(() => {
    outputPath = createTmpOutputPath();
  });

  afterEach(async () => {
    const dir = join(outputPath, "..");
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("map", () => {
    it("converts skills to plugin stub entries", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skills: OpenClawSkillConfig[] = [
        makeSkill({ name: "alpha", description: "Alpha skill" }),
        makeSkill({ name: "beta", description: "Beta skill", version: "2.0.0" }),
        makeSkill({ name: "gamma" }),
      ];

      const result = await mapper.map(skills);

      expect(result.converted).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      const stubs = await readStubs(outputPath);
      expect(stubs).toHaveLength(3);

      expect(stubs[0].id).toBe("openclaw-alpha");
      expect(stubs[0].name).toBe("alpha");
      expect(stubs[0].description).toBe("Alpha skill");
      expect(stubs[0].source).toBe("openclaw-import");
      expect(stubs[0].enabled).toBe(false);

      expect(stubs[1].id).toBe("openclaw-beta");
      expect(stubs[1].version).toBe("2.0.0");

      expect(stubs[2].id).toBe("openclaw-gamma");
    });

    it("sets correct metadata from skill fields", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skills: OpenClawSkillConfig[] = [
        makeSkill({
          name: "my-tool",
          author: "Alice",
          entryPoint: "./skills/my-tool/main.ts",
        }),
      ];

      const result = await mapper.map(skills);

      expect(result.converted).toBe(1);

      const stubs = await readStubs(outputPath);
      expect(stubs[0].metadata.originalAuthor).toBe("Alice");
      expect(stubs[0].metadata.originalEntryPoint).toBe("./skills/my-tool/main.ts");
    });

    it("defaults version to 0.0.0 when not provided", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skill = makeSkill({ name: "no-version" });
      delete (skill as Record<string, unknown>).version;

      const result = await mapper.map([skill]);

      expect(result.converted).toBe(1);

      const stubs = await readStubs(outputPath);
      expect(stubs[0].version).toBe("0.0.0");
    });

    it("defaults description to empty string when not provided", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skill = makeSkill({ name: "no-desc" });
      delete (skill as Record<string, unknown>).description;

      const result = await mapper.map([skill]);

      expect(result.converted).toBe(1);

      const stubs = await readStubs(outputPath);
      expect(stubs[0].description).toBe("");
    });

    it("skips skills with duplicate ids already in the output file", async () => {
      const mapper = new SkillMapper({ outputPath });

      // First batch: 3 skills
      const batch1: OpenClawSkillConfig[] = [
        makeSkill({ name: "alpha" }),
        makeSkill({ name: "beta" }),
        makeSkill({ name: "gamma" }),
      ];

      const result1 = await mapper.map(batch1);
      expect(result1.converted).toBe(3);
      expect(result1.skipped).toBe(0);

      // Second batch: 2 skills, 1 duplicate (alpha)
      const batch2: OpenClawSkillConfig[] = [
        makeSkill({ name: "alpha" }),
        makeSkill({ name: "delta" }),
      ];

      const result2 = await mapper.map(batch2);
      expect(result2.converted).toBe(1);
      expect(result2.skipped).toBe(1);

      const stubs = await readStubs(outputPath);
      expect(stubs).toHaveLength(4);

      const ids = stubs.map((s) => s.id);
      expect(ids).toContain("openclaw-alpha");
      expect(ids).toContain("openclaw-beta");
      expect(ids).toContain("openclaw-gamma");
      expect(ids).toContain("openclaw-delta");
    });

    it("skips duplicates within the same batch", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skills: OpenClawSkillConfig[] = [
        makeSkill({ name: "dup" }),
        makeSkill({ name: "dup" }),
        makeSkill({ name: "unique" }),
      ];

      const result = await mapper.map(skills);

      expect(result.converted).toBe(2);
      expect(result.skipped).toBe(1);

      const stubs = await readStubs(outputPath);
      expect(stubs).toHaveLength(2);
    });

    it("skips skills with empty or missing name", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skills: OpenClawSkillConfig[] = [
        makeSkill({ name: "" }),
        makeSkill({ name: "  " }),
        makeSkill({ name: "valid" }),
      ];

      const result = await mapper.map(skills);

      expect(result.converted).toBe(1);
      expect(result.skipped).toBe(2);
      expect(result.errors).toHaveLength(2);
      expect(result.errors[0].item).toBe("(unnamed)");
      expect(result.errors[0].reason).toBe("Skill has no name");
    });

    it("does not write to disk in dry-run mode", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skills: OpenClawSkillConfig[] = [
        makeSkill({ name: "dry-alpha" }),
        makeSkill({ name: "dry-beta" }),
      ];

      const result = await mapper.map(skills, { dryRun: true });

      expect(result.converted).toBe(2);
      expect(result.skipped).toBe(0);

      const fileExists = await Bun.file(outputPath).exists();
      expect(fileExists).toBe(false);
    });

    it("invokes onProgress callback for each skill", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skills: OpenClawSkillConfig[] = [
        makeSkill({ name: "a" }),
        makeSkill({ name: "b" }),
        makeSkill({ name: "c" }),
      ];

      const progressCalls: Array<[number, number]> = [];
      const result = await mapper.map(skills, {
        onProgress: (processed, total) => {
          progressCalls.push([processed, total]);
        },
      });

      expect(result.converted).toBe(3);
      expect(progressCalls).toEqual([
        [1, 3],
        [2, 3],
        [3, 3],
      ]);
    });

    it("handles empty skills array", async () => {
      const mapper = new SkillMapper({ outputPath });

      const result = await mapper.map([]);

      expect(result.converted).toBe(0);
      expect(result.skipped).toBe(0);
      expect(result.errors).toHaveLength(0);

      const fileExists = await Bun.file(outputPath).exists();
      expect(fileExists).toBe(false);
    });

    it("all stubs have source set to openclaw-import", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skills: OpenClawSkillConfig[] = [
        makeSkill({ name: "x" }),
        makeSkill({ name: "y" }),
      ];

      await mapper.map(skills);

      const stubs = await readStubs(outputPath);
      for (const stub of stubs) {
        expect(stub.source).toBe("openclaw-import");
      }
    });

    it("all stubs have enabled set to false", async () => {
      const mapper = new SkillMapper({ outputPath });
      const skills: OpenClawSkillConfig[] = [
        makeSkill({ name: "x" }),
        makeSkill({ name: "y" }),
      ];

      await mapper.map(skills);

      const stubs = await readStubs(outputPath);
      for (const stub of stubs) {
        expect(stub.enabled).toBe(false);
      }
    });

    it("handles missing optional fields gracefully", async () => {
      const mapper = new SkillMapper({ outputPath });
      const minimalSkill: OpenClawSkillConfig = { name: "minimal" };

      const result = await mapper.map([minimalSkill]);

      expect(result.converted).toBe(1);

      const stubs = await readStubs(outputPath);
      expect(stubs[0].id).toBe("openclaw-minimal");
      expect(stubs[0].description).toBe("");
      expect(stubs[0].version).toBe("0.0.0");
      expect(stubs[0].metadata.originalAuthor).toBeUndefined();
      expect(stubs[0].metadata.originalEntryPoint).toBeUndefined();
    });

    it("appends to existing stubs file without overwriting", async () => {
      const mapper = new SkillMapper({ outputPath });

      await mapper.map([makeSkill({ name: "first" })]);
      const stubsAfterFirst = await readStubs(outputPath);
      expect(stubsAfterFirst).toHaveLength(1);

      await mapper.map([makeSkill({ name: "second" })]);
      const stubsAfterSecond = await readStubs(outputPath);
      expect(stubsAfterSecond).toHaveLength(2);
      expect(stubsAfterSecond[0].id).toBe("openclaw-first");
      expect(stubsAfterSecond[1].id).toBe("openclaw-second");
    });
  });

  describe("default output path", () => {
    it("uses ~/.reins/plugins-imported.json when no outputPath given", async () => {
      // Use injected file ops to avoid writing to real home dir
      const written: Array<{ path: string; data: unknown }> = [];
      const mockFileOps: SkillMapperFileOps = {
        async readJson(): Promise<unknown> {
          return [];
        },
        async writeJson(path: string, data: unknown): Promise<void> {
          written.push({ path, data });
        },
        async exists(): Promise<boolean> {
          return false;
        },
      };

      const mapper = new SkillMapper(undefined, mockFileOps);
      await mapper.map([makeSkill({ name: "test" })]);

      expect(written).toHaveLength(1);
      expect(written[0].path).toContain(".reins");
      expect(written[0].path).toContain("plugins-imported.json");
    });
  });

  describe("file ops injection", () => {
    it("uses injected file ops for all I/O", async () => {
      const store: PluginStubEntry[] = [];
      const mockFileOps: SkillMapperFileOps = {
        async readJson(): Promise<unknown> {
          return [...store];
        },
        async writeJson(_path: string, data: unknown): Promise<void> {
          store.length = 0;
          store.push(...(data as PluginStubEntry[]));
        },
        async exists(): Promise<boolean> {
          return store.length > 0;
        },
      };

      const mapper = new SkillMapper({ outputPath: "/fake/path.json" }, mockFileOps);

      await mapper.map([makeSkill({ name: "injected" })]);

      expect(store).toHaveLength(1);
      expect(store[0].id).toBe("openclaw-injected");
      expect(store[0].source).toBe("openclaw-import");
      expect(store[0].enabled).toBe(false);
    });
  });
});
