import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureDataDirectories,
  getCronDir,
  getDataRoot,
  getGatewayDir,
  getLogsDir,
  getSessionsDir,
  getTranscriptsDir,
} from "../../src/daemon/paths";

const createdDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-daemon-paths-"));
  createdDirectories.push(directory);
  return directory;
}

describe("daemon path resolution", () => {
  it("resolves linux data root to ~/.reins when XDG_DATA_HOME is unset", () => {
    const homeDirectory = "/tmp/reins-home-linux";

    expect(getDataRoot({ platform: "linux", env: {}, homeDirectory })).toBe("/tmp/reins-home-linux/.reins");
  });

  it("ignores XDG_DATA_HOME on linux and always uses ~/.reins", () => {
    const homeDirectory = "/tmp/reins-home-linux";

    expect(
      getDataRoot({
        platform: "linux",
        env: { XDG_DATA_HOME: "/tmp/reins-data" },
        homeDirectory,
      }),
    ).toBe("/tmp/reins-home-linux/.reins");
  });

  it("resolves macOS and Windows data roots to platform defaults", () => {
    expect(getDataRoot({ platform: "darwin", homeDirectory: "/Users/reins" })).toBe(
      "/Users/reins/Library/Application Support/reins",
    );

    expect(
      getDataRoot({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\Reins\\AppData\\Roaming" },
        homeDirectory: "C:\\Users\\Reins",
      }),
    ).toBe("C:\\Users\\Reins\\AppData\\Roaming\\reins");
  });

  it("returns deterministic subdirectory paths", () => {
    const options = {
      platform: "linux" as const,
      env: {},
      homeDirectory: "/tmp/reins-home",
    };

    expect(getSessionsDir(options)).toBe("/tmp/reins-home/.reins/sessions");
    expect(getTranscriptsDir(options)).toBe("/tmp/reins-home/.reins/transcripts");
    expect(getCronDir(options)).toBe("/tmp/reins-home/.reins/cron");
    expect(getGatewayDir(options)).toBe("/tmp/reins-home/.reins/gateway");
    expect(getLogsDir(options)).toBe("/tmp/reins-home/.reins/logs");
  });
});

describe("ensureDataDirectories", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) {
        continue;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates daemon data directories with secure permissions", async () => {
    const tempRoot = await createTempDirectory();

    const result = await ensureDataDirectories({
      platform: "linux",
      env: {},
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const expectedRoot = join(tempRoot, ".reins");
    const directories = Object.values(result.value);
    expect(directories.every((directory) => directory.startsWith(expectedRoot))).toBe(true);

    for (const directory of directories) {
      const metadata = await stat(directory);
      expect(metadata.isDirectory()).toBe(true);
      expect(metadata.mode & 0o777).toBe(0o700);
    }
  });

  it("returns Result error when directory bootstrap fails", async () => {
    const tempRoot = await createTempDirectory();
    const blockingPath = join(tempRoot, "not-a-directory");
    await writeFile(blockingPath, "blocking file", "utf8");

    const result = await ensureDataDirectories({
      platform: "linux",
      env: {},
      homeDirectory: blockingPath,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DAEMON_DIRECTORY_INIT_FAILED");
    }
  });
});
