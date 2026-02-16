import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileSkillStateStore } from "../../src/skills/state-store";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reins-skill-state-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("FileSkillStateStore", () => {
  describe("load", () => {
    it("loads persisted state from a valid JSON file", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      await writeFile(filePath, JSON.stringify({
        "git-helper": { enabled: false },
        "docker-compose": { enabled: true },
      }));

      const store = new FileSkillStateStore(filePath);
      await store.load();

      expect(store.getEnabled("git-helper")).toBe(false);
      expect(store.getEnabled("docker-compose")).toBe(true);
    });

    it("handles missing file gracefully on first run", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nonexistent", "skill-state.json");

      const store = new FileSkillStateStore(filePath);
      await store.load();

      expect(store.getEnabled("anything")).toBeUndefined();
    });

    it("handles corrupt JSON file gracefully", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      await writeFile(filePath, "not valid json {{{");

      const store = new FileSkillStateStore(filePath);
      await store.load();

      expect(store.getEnabled("anything")).toBeUndefined();
    });

    it("ignores entries with invalid structure", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      await writeFile(filePath, JSON.stringify({
        "valid-skill": { enabled: true },
        "bad-entry": { enabled: "not-a-boolean" },
        "another-bad": "just a string",
        "null-entry": null,
      }));

      const store = new FileSkillStateStore(filePath);
      await store.load();

      expect(store.getEnabled("valid-skill")).toBe(true);
      expect(store.getEnabled("bad-entry")).toBeUndefined();
      expect(store.getEnabled("another-bad")).toBeUndefined();
      expect(store.getEnabled("null-entry")).toBeUndefined();
    });

    it("normalizes skill names on load", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      await writeFile(filePath, JSON.stringify({
        "  Git-Helper  ": { enabled: false },
      }));

      const store = new FileSkillStateStore(filePath);
      await store.load();

      expect(store.getEnabled("git-helper")).toBe(false);
    });
  });

  describe("getEnabled", () => {
    it("returns undefined for unknown skill", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      const store = new FileSkillStateStore(filePath);
      await store.load();

      expect(store.getEnabled("nonexistent")).toBeUndefined();
    });

    it("normalizes skill name for lookup", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      await writeFile(filePath, JSON.stringify({
        "my-skill": { enabled: true },
      }));

      const store = new FileSkillStateStore(filePath);
      await store.load();

      expect(store.getEnabled("  MY-SKILL  ")).toBe(true);
    });
  });

  describe("setEnabled", () => {
    it("sets enabled state and persists immediately", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      const store = new FileSkillStateStore(filePath);
      await store.load();

      store.setEnabled("new-skill", false);

      expect(store.getEnabled("new-skill")).toBe(false);

      // Wait for async save to complete
      await new Promise((resolve) => setTimeout(resolve, 50));

      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed["new-skill"]).toEqual({ enabled: false });
    });

    it("overwrites existing state", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      await writeFile(filePath, JSON.stringify({
        "toggle-skill": { enabled: true },
      }));

      const store = new FileSkillStateStore(filePath);
      await store.load();

      expect(store.getEnabled("toggle-skill")).toBe(true);

      store.setEnabled("toggle-skill", false);

      expect(store.getEnabled("toggle-skill")).toBe(false);
    });

    it("normalizes skill name on set", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      const store = new FileSkillStateStore(filePath);
      await store.load();

      store.setEnabled("  MY-SKILL  ", true);

      expect(store.getEnabled("my-skill")).toBe(true);
    });
  });

  describe("save and load round-trip", () => {
    it("persists and restores state across store instances", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "skill-state.json");

      // First instance: set some state
      const store1 = new FileSkillStateStore(filePath);
      await store1.load();
      store1.setEnabled("skill-a", true);
      store1.setEnabled("skill-b", false);
      store1.setEnabled("skill-c", true);
      await store1.save();

      // Second instance: load and verify
      const store2 = new FileSkillStateStore(filePath);
      await store2.load();

      expect(store2.getEnabled("skill-a")).toBe(true);
      expect(store2.getEnabled("skill-b")).toBe(false);
      expect(store2.getEnabled("skill-c")).toBe(true);
      expect(store2.getEnabled("unknown")).toBeUndefined();
    });

    it("creates parent directories on save if missing", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "nested", "deep", "skill-state.json");

      const store = new FileSkillStateStore(filePath);
      store.setEnabled("test-skill", false);
      await store.save();

      const raw = await readFile(filePath, "utf8");
      const parsed = JSON.parse(raw);
      expect(parsed["test-skill"]).toEqual({ enabled: false });
    });
  });
});
