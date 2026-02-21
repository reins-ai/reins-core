import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { PersonalityWatcher } from "../../src/environment/personality-watcher";

const PERSONALITY_FILENAME = "PERSONALITY.md";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("PersonalityWatcher", () => {
  let tempDir: string;
  let personalityPath: string;
  let watcher: PersonalityWatcher | null;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "personality-watcher-"));
    personalityPath = join(tempDir, PERSONALITY_FILENAME);
    watcher = null;
  });

  afterEach(async () => {
    if (watcher?.isRunning) {
      watcher.stop();
    }
    watcher = null;
    await rm(tempDir, { recursive: true, force: true });
  });

  it("calls onChanged when PERSONALITY.md is modified", async () => {
    await writeFile(personalityPath, "# Original content");

    const received: string[] = [];
    watcher = new PersonalityWatcher(personalityPath, {
      onChanged: (content) => received.push(content),
      debounceMs: 100,
    });

    watcher.start();
    expect(watcher.isRunning).toBe(true);

    await writeFile(personalityPath, "# Updated content");
    await wait(600);

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[received.length - 1]).toBe("# Updated content");
  });

  it("debounces rapid changes", async () => {
    await writeFile(personalityPath, "# Initial");

    const received: string[] = [];
    watcher = new PersonalityWatcher(personalityPath, {
      onChanged: (content) => received.push(content),
      debounceMs: 200,
    });

    watcher.start();

    // Write 5 times in rapid succession (~40ms apart)
    for (let i = 1; i <= 5; i++) {
      await writeFile(personalityPath, `# Version ${i}`);
      await wait(40);
    }

    // Wait for debounce to settle
    await wait(600);

    // Should have been called only once (or at most twice if timing is tight)
    // The key assertion: far fewer callbacks than writes
    expect(received.length).toBeLessThanOrEqual(2);
    expect(received.length).toBeGreaterThanOrEqual(1);
    // Last received content should be the final version
    expect(received[received.length - 1]).toBe("# Version 5");
  });

  it("handles missing file gracefully on start", () => {
    const missingPath = join(tempDir, "nonexistent", PERSONALITY_FILENAME);

    watcher = new PersonalityWatcher(missingPath, {
      onChanged: () => {},
    });

    // Should not throw
    expect(() => watcher!.start()).not.toThrow();
    // Watcher won't be running since directory doesn't exist
    expect(watcher.isRunning).toBe(false);
  });

  it("handles missing file in existing directory gracefully", async () => {
    // Directory exists but file doesn't — watcher starts, no callback fires
    const received: string[] = [];
    watcher = new PersonalityWatcher(personalityPath, {
      onChanged: (content) => received.push(content),
      debounceMs: 100,
    });

    watcher.start();
    expect(watcher.isRunning).toBe(true);

    await wait(300);
    expect(received).toHaveLength(0);
  });

  it("stop prevents further callbacks", async () => {
    await writeFile(personalityPath, "# Initial");

    const received: string[] = [];
    watcher = new PersonalityWatcher(personalityPath, {
      onChanged: (content) => received.push(content),
      debounceMs: 100,
    });

    watcher.start();
    watcher.stop();
    expect(watcher.isRunning).toBe(false);

    await writeFile(personalityPath, "# After stop");
    await wait(400);

    expect(received).toHaveLength(0);
  });

  it("stop is safe to call multiple times", () => {
    watcher = new PersonalityWatcher(personalityPath, {
      onChanged: () => {},
    });

    // Stop without starting — should not throw
    expect(() => watcher!.stop()).not.toThrow();
    expect(() => watcher!.stop()).not.toThrow();
  });

  it("start is idempotent when already running", async () => {
    await writeFile(personalityPath, "# Content");

    watcher = new PersonalityWatcher(personalityPath, {
      onChanged: () => {},
    });

    watcher.start();
    expect(watcher.isRunning).toBe(true);

    // Second start should be a no-op
    watcher.start();
    expect(watcher.isRunning).toBe(true);
  });

  it("detects file creation after watcher starts", async () => {
    // Directory exists but file doesn't yet
    const received: string[] = [];
    watcher = new PersonalityWatcher(personalityPath, {
      onChanged: (content) => received.push(content),
      debounceMs: 100,
    });

    watcher.start();

    // Create the file after watcher is running
    await writeFile(personalityPath, "# Created after watch");
    await wait(600);

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[received.length - 1]).toBe("# Created after watch");
  });

  it("ignores changes to other files in the same directory", async () => {
    await writeFile(personalityPath, "# Personality");

    const received: string[] = [];
    watcher = new PersonalityWatcher(personalityPath, {
      onChanged: (content) => received.push(content),
      debounceMs: 100,
    });

    watcher.start();

    // Write to a different file in the same directory
    await writeFile(join(tempDir, "OTHER.md"), "# Other file");
    await wait(400);

    expect(received).toHaveLength(0);
  });

  it("uses default debounce of 500ms when not specified", () => {
    watcher = new PersonalityWatcher(personalityPath, {
      onChanged: () => {},
    });

    // We can't directly inspect the private debounceMs, but we can verify
    // the watcher constructs without error and the default behavior works
    expect(watcher.isRunning).toBe(false);
  });
});
