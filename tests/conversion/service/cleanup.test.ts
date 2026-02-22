import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";

import { CleanupService } from "../../../src/conversion/cleanup";

describe("CleanupService", () => {
  it("archives OpenClaw state into timestamped backup path", async () => {
    const commands: string[][] = [];
    const cleanup = new CleanupService({
      spawner: async (command) => {
        commands.push(command);
        return 0;
      },
    });

    const result = await cleanup.archive({
      confirmed: true,
      openClawStatePath: "/tmp/openclaw",
      outputDir: "/tmp",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toMatch(/\/tmp\/openclaw-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.zip$/);
    expect(commands).toHaveLength(1);

    if (process.platform === "win32") {
      expect(commands[0][0]).toBe("powershell");
      expect(commands[0][2]).toContain("Compress-Archive");
    } else {
      expect(commands[0]).toEqual(["zip", "-r", result.value, "/tmp/openclaw"]);
    }
  });

  it("returns ARCHIVE_FAILED when archive command exits non-zero", async () => {
    const cleanup = new CleanupService({
      spawner: async () => 1,
    });

    const result = await cleanup.archive({
      confirmed: true,
      openClawStatePath: "/tmp/openclaw",
      outputDir: "/tmp",
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("ARCHIVE_FAILED");
  });

  it("uninstalls service without deleting state directory by default", async () => {
    const commands: string[][] = [];
    const statePath = "/tmp/openclaw-state";
    const cleanup = new CleanupService({
      spawner: async (command) => {
        commands.push(command);
        return 0;
      },
    });

    const result = await cleanup.uninstall({
      confirmed: true,
      openClawStatePath: statePath,
      removeStateDir: false,
    });

    expect(result.ok).toBe(true);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some((command) => command.includes(statePath))).toBe(false);
  });

  it("deletes state directory only when removeStateDir is true", async () => {
    const commands: string[][] = [];
    const statePath = "/tmp/openclaw-state";
    const cleanup = new CleanupService({
      spawner: async (command) => {
        commands.push(command);
        return 0;
      },
    });

    const result = await cleanup.uninstall({
      confirmed: true,
      openClawStatePath: statePath,
      removeStateDir: true,
    });

    expect(result.ok).toBe(true);
    expect(commands.some((command) => command.includes(statePath))).toBe(true);
  });

  it("refuses to remove protected Reins data paths", async () => {
    const commands: string[][] = [];
    const cleanup = new CleanupService({
      spawner: async (command) => {
        commands.push(command);
        return 0;
      },
      homeDir: "/home/test-user",
      platform: "linux",
    });

    const result = await cleanup.uninstall({
      confirmed: true,
      openClawStatePath: "/home/test-user/.reins",
      removeStateDir: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe("UNSAFE_PATH");
    expect(commands).toHaveLength(0);
  });

  it("enforces confirmed true at the type level", () => {
    // @ts-expect-error confirmed: true is required
    void ({ openClawStatePath: "/tmp/openclaw" } satisfies Parameters<CleanupService["archive"]>[0]);
    // @ts-expect-error confirmed: true is required
    void ({ openClawStatePath: "/tmp/openclaw" } satisfies Parameters<CleanupService["uninstall"]>[0]);
  });
});
