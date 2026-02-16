import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import { SkillWatcher } from "../../src/skills/watcher";
import type { SkillWatcherCallbacks } from "../../src/skills/watcher";
import { SkillRegistry } from "../../src/skills/registry";
import { SkillScanner } from "../../src/skills/scanner";
import type { Skill } from "../../src/skills/types";

const tempDirs: string[] = [];
const activeWatchers: SkillWatcher[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reins-skill-watcher-"));
  tempDirs.push(dir);
  return dir;
}

function trackWatcher(watcher: SkillWatcher): SkillWatcher {
  activeWatchers.push(watcher);
  return watcher;
}

function makeSkillMd(name: string, description?: string): string {
  return `---
name: ${name}
description: ${description ?? `Description for ${name}`}
---

# ${name}

Body content for ${name}.
`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  for (const watcher of activeWatchers) {
    watcher.stop();
  }
  activeWatchers.length = 0;
});

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("SkillWatcher", () => {
  describe("lifecycle", () => {
    it("starts and stops without error", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      const watcher = trackWatcher(
        new SkillWatcher(registry, dir),
      );

      expect(watcher.watching).toBe(false);
      watcher.start();
      expect(watcher.watching).toBe(true);
      watcher.stop();
      expect(watcher.watching).toBe(false);
    });

    it("start() is a no-op when already watching", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      const watcher = trackWatcher(
        new SkillWatcher(registry, dir),
      );

      watcher.start();
      expect(watcher.watching).toBe(true);

      // Second start should not throw or change state
      watcher.start();
      expect(watcher.watching).toBe(true);

      watcher.stop();
      expect(watcher.watching).toBe(false);
    });

    it("stop() is safe to call when not watching", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      const watcher = trackWatcher(
        new SkillWatcher(registry, dir),
      );

      // Should not throw
      watcher.stop();
      expect(watcher.watching).toBe(false);
    });

    it("stop() cancels pending debounced rescan", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      let addedCount = 0;

      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          { onSkillAdded: () => { addedCount++; } },
          { debounceMs: 200 },
        ),
      );

      watcher.start();

      // Create a skill to trigger a change event
      await mkdir(join(dir, "new-skill"));
      await writeFile(join(dir, "new-skill", "SKILL.md"), makeSkillMd("new-skill"));

      // Stop immediately before debounce fires
      await wait(50);
      watcher.stop();

      // Wait past the debounce period
      await wait(400);

      // Callback should not have fired since we stopped
      expect(addedCount).toBe(0);
    });
  });

  describe("rescan", () => {
    it("detects a new skill directory added after start", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      const added: Skill[] = [];

      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          { onSkillAdded: (skill) => { added.push(skill); } },
          { debounceMs: 100 },
        ),
      );

      watcher.start();

      // Add a new skill directory
      await mkdir(join(dir, "fresh-skill"));
      await writeFile(
        join(dir, "fresh-skill", "SKILL.md"),
        makeSkillMd("fresh-skill"),
      );

      // Wait for debounce + processing
      await wait(600);

      expect(added).toHaveLength(1);
      expect(added[0].config.name).toBe("fresh-skill");
      expect(registry.has("fresh-skill")).toBe(true);
    });

    it("detects a skill directory removed after start", async () => {
      const dir = await createTempDir();

      // Create initial skill
      await mkdir(join(dir, "doomed-skill"));
      await writeFile(
        join(dir, "doomed-skill", "SKILL.md"),
        makeSkillMd("doomed-skill"),
      );

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      expect(registry.has("doomed-skill")).toBe(true);

      const removed: string[] = [];
      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          { onSkillRemoved: (name) => { removed.push(name); } },
          { debounceMs: 100 },
        ),
      );

      watcher.start();

      // Remove the skill directory
      await rm(join(dir, "doomed-skill"), { recursive: true, force: true });

      // Wait for debounce + processing
      await wait(600);

      expect(removed).toHaveLength(1);
      expect(removed[0]).toBe("doomed-skill");
      expect(registry.has("doomed-skill")).toBe(false);
    });

    it("detects SKILL.md content changes", async () => {
      const dir = await createTempDir();

      // Create initial skill
      await mkdir(join(dir, "mutable-skill"));
      await writeFile(
        join(dir, "mutable-skill", "SKILL.md"),
        makeSkillMd("mutable-skill", "Original description"),
      );

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      expect(registry.getOrThrow("mutable-skill").summary.description).toBe(
        "Original description",
      );

      const changed: Skill[] = [];
      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          { onSkillChanged: (skill) => { changed.push(skill); } },
          { debounceMs: 100 },
        ),
      );

      watcher.start();

      // First rescan seeds the content cache — trigger it manually
      await watcher.rescan();

      // Now modify the SKILL.md
      await writeFile(
        join(dir, "mutable-skill", "SKILL.md"),
        makeSkillMd("mutable-skill", "Updated description"),
      );

      // Wait for debounce + processing
      await wait(600);

      expect(changed).toHaveLength(1);
      expect(changed[0].summary.description).toBe("Updated description");
      expect(registry.getOrThrow("mutable-skill").summary.description).toBe(
        "Updated description",
      );
    });

    it("handles multiple skills added at once", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      const added: Skill[] = [];

      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          { onSkillAdded: (skill) => { added.push(skill); } },
          { debounceMs: 100 },
        ),
      );

      watcher.start();

      // Add multiple skills rapidly
      await mkdir(join(dir, "skill-x"));
      await writeFile(join(dir, "skill-x", "SKILL.md"), makeSkillMd("skill-x"));
      await mkdir(join(dir, "skill-y"));
      await writeFile(join(dir, "skill-y", "SKILL.md"), makeSkillMd("skill-y"));

      // Wait for debounce + processing
      await wait(600);

      expect(added).toHaveLength(2);
      const names = added.map((s) => s.config.name).sort();
      expect(names).toEqual(["skill-x", "skill-y"]);
      expect(registry.has("skill-x")).toBe(true);
      expect(registry.has("skill-y")).toBe(true);
    });

    it("ignores invalid skill directories during rescan", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      const added: Skill[] = [];

      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          { onSkillAdded: (skill) => { added.push(skill); } },
          { debounceMs: 100 },
        ),
      );

      watcher.start();

      // Add a directory without SKILL.md (invalid)
      await mkdir(join(dir, "not-a-skill"));
      await writeFile(join(dir, "not-a-skill", "README.md"), "# Not a skill");

      // Add a valid skill
      await mkdir(join(dir, "valid-skill"));
      await writeFile(
        join(dir, "valid-skill", "SKILL.md"),
        makeSkillMd("valid-skill"),
      );

      await wait(600);

      expect(added).toHaveLength(1);
      expect(added[0].config.name).toBe("valid-skill");
    });

    it("does not fire callbacks after stop()", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      let callbackCount = 0;

      const callbacks: SkillWatcherCallbacks = {
        onSkillAdded: () => { callbackCount++; },
        onSkillChanged: () => { callbackCount++; },
        onSkillRemoved: () => { callbackCount++; },
      };

      const watcher = trackWatcher(
        new SkillWatcher(registry, dir, callbacks, { debounceMs: 100 }),
      );

      watcher.start();
      watcher.stop();

      // Make changes after stop
      await mkdir(join(dir, "late-skill"));
      await writeFile(
        join(dir, "late-skill", "SKILL.md"),
        makeSkillMd("late-skill"),
      );

      await wait(400);

      expect(callbackCount).toBe(0);
    });
  });

  describe("debouncing", () => {
    it("coalesces rapid filesystem events into a single rescan", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      const added: Skill[] = [];

      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          { onSkillAdded: (skill) => { added.push(skill); } },
          { debounceMs: 200 },
        ),
      );

      watcher.start();

      // Rapid-fire filesystem changes
      await mkdir(join(dir, "rapid-a"));
      await writeFile(join(dir, "rapid-a", "SKILL.md"), makeSkillMd("rapid-a"));
      await wait(50);
      await mkdir(join(dir, "rapid-b"));
      await writeFile(join(dir, "rapid-b", "SKILL.md"), makeSkillMd("rapid-b"));
      await wait(50);
      await mkdir(join(dir, "rapid-c"));
      await writeFile(join(dir, "rapid-c", "SKILL.md"), makeSkillMd("rapid-c"));

      // Wait for debounce to fire
      await wait(600);

      // All three should be discovered in a single rescan
      expect(added).toHaveLength(3);
      expect(registry.list()).toHaveLength(3);
    });

    it("uses custom debounce interval", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      const added: Skill[] = [];

      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          { onSkillAdded: (skill) => { added.push(skill); } },
          { debounceMs: 50 },
        ),
      );

      watcher.start();

      await mkdir(join(dir, "quick-skill"));
      await writeFile(
        join(dir, "quick-skill", "SKILL.md"),
        makeSkillMd("quick-skill"),
      );

      // With 50ms debounce, should fire quickly
      await wait(300);

      expect(added).toHaveLength(1);
      expect(added[0].config.name).toBe("quick-skill");
    });
  });

  describe("rescan method (direct)", () => {
    it("can be called directly to force a rescan", async () => {
      const dir = await createTempDir();

      // Create a skill before starting
      await mkdir(join(dir, "pre-existing"));
      await writeFile(
        join(dir, "pre-existing", "SKILL.md"),
        makeSkillMd("pre-existing"),
      );

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      const added: Skill[] = [];
      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          { onSkillAdded: (skill) => { added.push(skill); } },
        ),
      );

      watcher.start();

      // Add a new skill without waiting for fs events
      await mkdir(join(dir, "direct-add"));
      await writeFile(
        join(dir, "direct-add", "SKILL.md"),
        makeSkillMd("direct-add"),
      );

      // Force rescan
      await watcher.rescan();

      expect(added).toHaveLength(1);
      expect(added[0].config.name).toBe("direct-add");
      expect(registry.has("direct-add")).toBe(true);
    });

    it("handles empty directory gracefully", async () => {
      const dir = await createTempDir();
      const registry = new SkillRegistry();
      const watcher = trackWatcher(
        new SkillWatcher(registry, dir),
      );

      watcher.start();

      // Should not throw
      await watcher.rescan();

      expect(registry.list()).toHaveLength(0);
    });

    it("handles non-existent directory gracefully", async () => {
      const registry = new SkillRegistry();
      const watcher = trackWatcher(
        new SkillWatcher(registry, "/tmp/does-not-exist-reins-watcher-xyz"),
      );

      // rescan should not throw even if directory doesn't exist
      await watcher.rescan();

      expect(registry.list()).toHaveLength(0);
    });
  });

  describe("integration with scanner", () => {
    it("works with pre-scanned registry from SkillScanner", async () => {
      const dir = await createTempDir();

      // Set up initial skills via scanner
      await mkdir(join(dir, "initial-a"));
      await writeFile(
        join(dir, "initial-a", "SKILL.md"),
        makeSkillMd("initial-a"),
      );
      await mkdir(join(dir, "initial-b"));
      await writeFile(
        join(dir, "initial-b", "SKILL.md"),
        makeSkillMd("initial-b"),
      );

      const registry = new SkillRegistry();
      const scanner = new SkillScanner(registry, dir);
      await scanner.scan();

      expect(registry.list()).toHaveLength(2);

      const added: Skill[] = [];
      const removed: string[] = [];

      const watcher = trackWatcher(
        new SkillWatcher(
          registry,
          dir,
          {
            onSkillAdded: (skill) => { added.push(skill); },
            onSkillRemoved: (name) => { removed.push(name); },
          },
          { debounceMs: 100 },
        ),
      );

      watcher.start();

      // Add a new skill
      await mkdir(join(dir, "new-skill"));
      await writeFile(
        join(dir, "new-skill", "SKILL.md"),
        makeSkillMd("new-skill"),
      );

      // Remove an existing skill
      await rm(join(dir, "initial-a"), { recursive: true, force: true });

      await wait(600);

      expect(added).toHaveLength(1);
      expect(added[0].config.name).toBe("new-skill");
      expect(removed).toHaveLength(1);
      expect(removed[0]).toBe("initial-a");

      expect(registry.has("initial-a")).toBe(false);
      expect(registry.has("initial-b")).toBe(true);
      expect(registry.has("new-skill")).toBe(true);
      expect(registry.list()).toHaveLength(2);
    });
  });
});
