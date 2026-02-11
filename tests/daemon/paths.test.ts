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

  it("resolves linux data root to XDG_DATA_HOME/reins when set", () => {
    const homeDirectory = "/tmp/reins-home-linux";

    expect(
      getDataRoot({
        platform: "linux",
        env: { XDG_DATA_HOME: "/tmp/reins-data" },
        homeDirectory,
      }),
    ).toBe("/tmp/reins-data/reins");
  });

  it("resolves macOS and Windows data roots to platform defaults", () => {
    expect(getDataRoot({ platform: "darwin", homeDirectory: "/Users/reins" })).toBe(
      "/Users/reins/Library/Application Support/Reins",
    );

    expect(
      getDataRoot({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\Reins\\AppData\\Roaming" },
        homeDirectory: "C:\\Users\\Reins",
      }),
    ).toBe("C:\\Users\\Reins\\AppData\\Roaming\\Reins");
  });

  it("returns deterministic subdirectory paths", () => {
    const options = {
      platform: "linux" as const,
      env: { XDG_DATA_HOME: "/tmp/reins-data" },
      homeDirectory: "/tmp/reins-home",
    };

    expect(getSessionsDir(options)).toBe("/tmp/reins-data/reins/sessions");
    expect(getTranscriptsDir(options)).toBe("/tmp/reins-data/reins/transcripts");
    expect(getCronDir(options)).toBe("/tmp/reins-data/reins/cron");
    expect(getGatewayDir(options)).toBe("/tmp/reins-data/reins/gateway");
    expect(getLogsDir(options)).toBe("/tmp/reins-data/reins/logs");
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
    const dataHome = join(tempRoot, "xdg-data");

    const result = await ensureDataDirectories({
      platform: "linux",
      env: { XDG_DATA_HOME: dataHome },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const directories = Object.values(result.value);
    expect(directories.every((directory) => directory.startsWith(dataHome))).toBe(true);

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
      env: { XDG_DATA_HOME: blockingPath },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("DAEMON_DIRECTORY_INIT_FAILED");
    }
  });
});
