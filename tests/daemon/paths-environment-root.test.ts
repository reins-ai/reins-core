import { afterEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureDataDirectories,
  getDataRoot,
} from "../../src/daemon/paths";
import {
  bootstrapInstallRoot,
  buildInstallPaths,
  resolveInstallRoot,
} from "../../src/environment/bootstrap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createdDirectories: string[] = [];

async function createTempDirectory(prefix = "reins-paths-"): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

// ---------------------------------------------------------------------------
// 1. Platform-specific root derivation
// ---------------------------------------------------------------------------

describe("platform-specific install root derivation", () => {
  describe("Linux", () => {
    it("resolves to ~/.reins when XDG_DATA_HOME is unset", () => {
      const root = resolveInstallRoot({
        platform: "linux",
        env: {},
        homeDirectory: "/home/alice",
      });
      expect(root).toBe("/home/alice/.reins");
    });

    it("resolves to XDG_DATA_HOME/reins when XDG_DATA_HOME is set", () => {
      const root = resolveInstallRoot({
        platform: "linux",
        env: { XDG_DATA_HOME: "/custom/data" },
        homeDirectory: "/home/alice",
      });
      expect(root).toBe("/custom/data/reins");
    });

    it("ignores XDG_DATA_HOME when it is empty string", () => {
      const root = resolveInstallRoot({
        platform: "linux",
        env: { XDG_DATA_HOME: "" },
        homeDirectory: "/home/alice",
      });
      expect(root).toBe("/home/alice/.reins");
    });

    it("ignores XDG_DATA_HOME when it is whitespace-only", () => {
      const root = resolveInstallRoot({
        platform: "linux",
        env: { XDG_DATA_HOME: "   " },
        homeDirectory: "/home/alice",
      });
      expect(root).toBe("/home/alice/.reins");
    });
  });

  describe("macOS", () => {
    it("resolves to ~/Library/Application Support/reins", () => {
      const root = resolveInstallRoot({
        platform: "darwin",
        homeDirectory: "/Users/bob",
      });
      expect(root).toBe("/Users/bob/Library/Application Support/reins");
    });

    it("uses provided homeDirectory, not process.env.HOME", () => {
      const root = resolveInstallRoot({
        platform: "darwin",
        homeDirectory: "/custom/home",
      });
      expect(root).toBe("/custom/home/Library/Application Support/reins");
    });
  });

  describe("Windows", () => {
    it("resolves to %APPDATA%\\reins when APPDATA is set", () => {
      const root = resolveInstallRoot({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\Carol\\AppData\\Roaming" },
        homeDirectory: "C:\\Users\\Carol",
      });
      expect(root).toBe("C:\\Users\\Carol\\AppData\\Roaming\\reins");
    });

    it("falls back to homeDirectory\\AppData\\Roaming\\reins when APPDATA is unset", () => {
      const root = resolveInstallRoot({
        platform: "win32",
        env: {},
        homeDirectory: "C:\\Users\\Carol",
      });
      expect(root).toBe("C:\\Users\\Carol\\AppData\\Roaming\\reins");
    });

    it("uses win32 path separators", () => {
      const root = resolveInstallRoot({
        platform: "win32",
        env: { APPDATA: "D:\\Data" },
        homeDirectory: "D:\\Users\\Test",
      });
      expect(root).toBe("D:\\Data\\reins");
      expect(root).not.toContain("/");
    });
  });

  describe("unknown platforms", () => {
    it("falls back to ~/.reins for freebsd", () => {
      const root = resolveInstallRoot({
        platform: "freebsd" as NodeJS.Platform,
        homeDirectory: "/home/user",
      });
      expect(root).toBe("/home/user/.reins");
    });

    it("falls back to ~/.reins for sunos", () => {
      const root = resolveInstallRoot({
        platform: "sunos" as NodeJS.Platform,
        homeDirectory: "/export/home/user",
      });
      expect(root).toBe("/export/home/user/.reins");
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Daemon paths and bootstrap paths consistency
// ---------------------------------------------------------------------------

describe("daemon paths and bootstrap paths consistency", () => {
  it("daemon getDataRoot and bootstrap resolveInstallRoot agree on Linux", () => {
    const options = {
      platform: "linux" as const,
      env: {},
      homeDirectory: "/home/user",
    };
    expect(getDataRoot(options)).toBe(resolveInstallRoot(options));
  });

  it("daemon getDataRoot and bootstrap resolveInstallRoot agree on macOS", () => {
    const options = {
      platform: "darwin" as const,
      homeDirectory: "/Users/user",
    };
    expect(getDataRoot(options)).toBe(resolveInstallRoot(options));
  });

  it("daemon getDataRoot and bootstrap resolveInstallRoot agree on Windows", () => {
    const options = {
      platform: "win32" as const,
      env: { APPDATA: "C:\\Users\\User\\AppData\\Roaming" },
      homeDirectory: "C:\\Users\\User",
    };
    expect(getDataRoot(options)).toBe(resolveInstallRoot(options));
  });

  it("daemon getDataRoot and bootstrap resolveInstallRoot agree with XDG_DATA_HOME", () => {
    const options = {
      platform: "linux" as const,
      env: { XDG_DATA_HOME: "/custom/xdg" },
      homeDirectory: "/home/user",
    };
    expect(getDataRoot(options)).toBe(resolveInstallRoot(options));
  });
});

// ---------------------------------------------------------------------------
// 3. Environment root paths structure
// ---------------------------------------------------------------------------

describe("environment root paths structure", () => {
  it("environments directory is under install root", () => {
    const paths = buildInstallPaths({
      platform: "linux",
      env: {},
      homeDirectory: "/home/user",
    });
    expect(paths.environmentsDir).toBe(`${paths.installRoot}/environments`);
  });

  it("default environment is under environments directory", () => {
    const paths = buildInstallPaths({
      platform: "linux",
      env: {},
      homeDirectory: "/home/user",
    });
    expect(paths.defaultEnvironmentDir).toBe(`${paths.environmentsDir}/default`);
  });

  it("global config path is under install root", () => {
    const paths = buildInstallPaths({
      platform: "linux",
      env: {},
      homeDirectory: "/home/user",
    });
    expect(paths.globalConfigPath).toBe(`${paths.installRoot}/config.json5`);
  });

  it("named environment path follows convention", () => {
    const paths = buildInstallPaths({
      platform: "linux",
      env: {},
      homeDirectory: "/home/user",
    });
    const namedEnvDir = join(paths.environmentsDir, "work");
    expect(namedEnvDir).toBe("/home/user/.reins/environments/work");
  });

  it("Windows paths use backslash separators throughout", () => {
    const paths = buildInstallPaths({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\Test\\AppData\\Roaming" },
      homeDirectory: "C:\\Users\\Test",
    });

    expect(paths.installRoot).toContain("\\");
    expect(paths.environmentsDir).toContain("\\");
    expect(paths.defaultEnvironmentDir).toContain("\\");
    expect(paths.globalConfigPath).toContain("\\");
  });

  it("macOS paths preserve spaces in Application Support", () => {
    const paths = buildInstallPaths({
      platform: "darwin",
      homeDirectory: "/Users/test",
    });
    expect(paths.installRoot).toContain("Application Support");
    expect(paths.environmentsDir).toContain("Application Support");
  });
});

// ---------------------------------------------------------------------------
// 4. Path edge cases — unicode, spaces, long names
// ---------------------------------------------------------------------------

describe("path edge cases", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("handles unicode characters in home directory path", () => {
    const root = resolveInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: "/home/用户",
    });
    expect(root).toBe("/home/用户/.reins");
  });

  it("handles spaces in home directory path", () => {
    const root = resolveInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: "/home/my user",
    });
    expect(root).toBe("/home/my user/.reins");
  });

  it("handles emoji in path components", () => {
    const root = resolveInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: "/home/🏠",
    });
    expect(root).toBe("/home/🏠/.reins");
  });

  it("handles very long home directory path", () => {
    const longSegment = "a".repeat(200);
    const root = resolveInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: `/home/${longSegment}`,
    });
    expect(root).toBe(`/home/${longSegment}/.reins`);
    expect(root.length).toBeGreaterThan(200);
  });

  it("handles unicode in XDG_DATA_HOME", () => {
    const root = resolveInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: "/données/locales" },
      homeDirectory: "/home/user",
    });
    expect(root).toBe("/données/locales/reins");
  });

  it("handles spaces in APPDATA on Windows", () => {
    const root = resolveInstallRoot({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\My User\\App Data" },
      homeDirectory: "C:\\Users\\My User",
    });
    expect(root).toBe("C:\\Users\\My User\\App Data\\reins");
  });

  it("bootstrap succeeds with unicode directory names on disk", async () => {
    const tempRoot = await createTempDirectory("reins-unicode-");
    const unicodeHome = join(tempRoot, "用户目录");
    await mkdir(unicodeHome, { recursive: true });

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: unicodeHome },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rootStat = await stat(result.value.paths.installRoot);
    expect(rootStat.isDirectory()).toBe(true);
  });

  it("bootstrap succeeds with spaces in directory names on disk", async () => {
    const tempRoot = await createTempDirectory("reins-spaces-");
    const spacedHome = join(tempRoot, "my data home");
    await mkdir(spacedHome, { recursive: true });

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: spacedHome },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const rootStat = await stat(result.value.paths.installRoot);
    expect(rootStat.isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Error and permission edge cases
// ---------------------------------------------------------------------------

describe("error and permission edge cases", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      // Restore permissions before cleanup
      try {
        await chmod(directory, 0o755);
      } catch {
        // Ignore if already removed
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("returns error when install root path is blocked by a file", async () => {
    const tempRoot = await createTempDirectory();
    const blockingPath = join(tempRoot, "blocked");
    await writeFile(blockingPath, "not a directory", "utf8");

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: blockingPath },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BOOTSTRAP_FAILED");
    }
  });

  it("returns error when daemon directory path is blocked by a file", async () => {
    const tempRoot = await createTempDirectory();
    const blockingPath = join(tempRoot, "blocked");
    await writeFile(blockingPath, "not a directory", "utf8");

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

  it("returns error when parent directory is read-only", async () => {
    const tempRoot = await createTempDirectory();
    const readOnlyDir = join(tempRoot, "readonly");
    await mkdir(readOnlyDir, { recursive: true });
    await chmod(readOnlyDir, 0o444);

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: join(readOnlyDir, "nested", "deep") },
      homeDirectory: tempRoot,
    });

    // Restore permissions for cleanup
    await chmod(readOnlyDir, 0o755);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("BOOTSTRAP_FAILED");
    }
  });

  it("bootstrap error includes descriptive message", async () => {
    const tempRoot = await createTempDirectory();
    const blockingPath = join(tempRoot, "blocked");
    await writeFile(blockingPath, "not a directory", "utf8");

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: blockingPath },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Failed to bootstrap install root");
      expect(result.error.name).toBe("EnvironmentBootstrapFailedError");
    }
  });

  it("daemon directory error includes descriptive message", async () => {
    const tempRoot = await createTempDirectory();
    const blockingPath = join(tempRoot, "blocked");
    await writeFile(blockingPath, "not a directory", "utf8");

    const result = await ensureDataDirectories({
      platform: "linux",
      env: { XDG_DATA_HOME: blockingPath },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Failed to initialize daemon data directories");
      expect(result.error.name).toBe("DaemonError");
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Concurrent bootstrap calls (idempotency under parallelism)
// ---------------------------------------------------------------------------

describe("concurrent bootstrap calls", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("parallel bootstrap calls all succeed without conflict", async () => {
    const tempRoot = await createTempDirectory();
    const options = {
      platform: "linux" as const,
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    };

    const results = await Promise.all([
      bootstrapInstallRoot(options),
      bootstrapInstallRoot(options),
      bootstrapInstallRoot(options),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(true);
    }

    // All resolve to the same paths
    const paths = results
      .filter((r) => r.ok)
      .map((r) => (r as { ok: true; value: { paths: { installRoot: string } } }).value.paths.installRoot);
    expect(new Set(paths).size).toBe(1);
  });

  it("parallel daemon directory creation all succeed", async () => {
    const tempRoot = await createTempDirectory();
    const options = {
      platform: "linux" as const,
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    };

    const results = await Promise.all([
      ensureDataDirectories(options),
      ensureDataDirectories(options),
      ensureDataDirectories(options),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(true);
    }
  });

  it("directories exist and are valid after concurrent bootstrap", async () => {
    const tempRoot = await createTempDirectory();
    const options = {
      platform: "linux" as const,
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    };

    await Promise.all([
      bootstrapInstallRoot(options),
      bootstrapInstallRoot(options),
    ]);

    const paths = buildInstallPaths(options);

    const rootStat = await stat(paths.installRoot);
    expect(rootStat.isDirectory()).toBe(true);

    const envsStat = await stat(paths.environmentsDir);
    expect(envsStat.isDirectory()).toBe(true);

    const defaultStat = await stat(paths.defaultEnvironmentDir);
    expect(defaultStat.isDirectory()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Regression guards — known path contracts
// ---------------------------------------------------------------------------

describe("regression guards — known path contracts", () => {
  it("Linux default root is exactly ~/.reins (dot-prefixed)", () => {
    const root = resolveInstallRoot({
      platform: "linux",
      env: {},
      homeDirectory: "/home/user",
    });
    expect(root).toEndWith("/.reins");
    expect(root).not.toEndWith("/reins");
  });

  it("macOS root uses lowercase reins in Application Support", () => {
    const root = resolveInstallRoot({
      platform: "darwin",
      homeDirectory: "/Users/user",
    });
    expect(root).toContain("/reins");
    expect(root).not.toContain("/Reins");
  });

  it("Windows root uses lowercase reins", () => {
    const root = resolveInstallRoot({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\User\\AppData\\Roaming" },
      homeDirectory: "C:\\Users\\User",
    });
    expect(root).toEndWith("\\reins");
  });

  it("Linux XDG root uses lowercase reins (no dot prefix)", () => {
    const root = resolveInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: "/custom/data" },
      homeDirectory: "/home/user",
    });
    expect(root).toEndWith("/reins");
    expect(root).not.toContain(".reins");
  });

  it("config file name is always config.json5", () => {
    const platforms: Array<{ platform: NodeJS.Platform; homeDirectory: string; env?: NodeJS.ProcessEnv }> = [
      { platform: "linux", homeDirectory: "/home/user", env: {} },
      { platform: "darwin", homeDirectory: "/Users/user" },
      { platform: "win32", homeDirectory: "C:\\Users\\User", env: { APPDATA: "C:\\Users\\User\\AppData\\Roaming" } },
    ];

    for (const opts of platforms) {
      const paths = buildInstallPaths(opts);
      // Split on both separators to handle cross-platform path strings
      const segments = paths.globalConfigPath.split(/[/\\]/);
      const configName = segments[segments.length - 1];
      expect(configName).toBe("config.json5");
    }
  });

  it("environments subdirectory name is always 'environments'", () => {
    const platforms: Array<{ platform: NodeJS.Platform; homeDirectory: string; env?: NodeJS.ProcessEnv }> = [
      { platform: "linux", homeDirectory: "/home/user", env: {} },
      { platform: "darwin", homeDirectory: "/Users/user" },
      { platform: "win32", homeDirectory: "C:\\Users\\User", env: { APPDATA: "C:\\Users\\User\\AppData\\Roaming" } },
    ];

    for (const opts of platforms) {
      const paths = buildInstallPaths(opts);
      expect(paths.environmentsDir).toContain("environments");
    }
  });

  it("default environment subdirectory name is always 'default'", () => {
    const platforms: Array<{ platform: NodeJS.Platform; homeDirectory: string; env?: NodeJS.ProcessEnv }> = [
      { platform: "linux", homeDirectory: "/home/user", env: {} },
      { platform: "darwin", homeDirectory: "/Users/user" },
      { platform: "win32", homeDirectory: "C:\\Users\\User", env: { APPDATA: "C:\\Users\\User\\AppData\\Roaming" } },
    ];

    for (const opts of platforms) {
      const paths = buildInstallPaths(opts);
      expect(paths.defaultEnvironmentDir).toContain("default");
    }
  });

  it("daemon data root and environment install root are the same directory", () => {
    const options = {
      platform: "linux" as const,
      env: {},
      homeDirectory: "/home/user",
    };
    const daemonRoot = getDataRoot(options);
    const envRoot = resolveInstallRoot(options);
    expect(daemonRoot).toBe(envRoot);
  });

  it("install paths are deterministic across repeated calls", () => {
    const options = {
      platform: "linux" as const,
      env: {},
      homeDirectory: "/home/user",
    };

    const first = buildInstallPaths(options);
    const second = buildInstallPaths(options);

    expect(first.installRoot).toBe(second.installRoot);
    expect(first.environmentsDir).toBe(second.environmentsDir);
    expect(first.defaultEnvironmentDir).toBe(second.defaultEnvironmentDir);
    expect(first.globalConfigPath).toBe(second.globalConfigPath);
  });

  it("DaemonPathOptions defaults produce consistent results when called without options", () => {
    // Both functions should produce the same root when called with identical explicit options
    // matching what the defaults would resolve to on the current platform
    const explicitOptions = {
      platform: process.platform,
      env: process.env,
      homeDirectory: join(tmpdir(), "regression-home"),
    };

    const daemonRoot = getDataRoot(explicitOptions);
    const envRoot = resolveInstallRoot(explicitOptions);
    expect(daemonRoot).toBe(envRoot);
  });
});

// ---------------------------------------------------------------------------
// 8. Filesystem bootstrap regression — directory structure matches spec
// ---------------------------------------------------------------------------

describe("filesystem bootstrap regression", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) continue;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bootstrap creates exactly the expected directory tree", async () => {
    const tempRoot = await createTempDirectory();
    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { paths } = result.value;

    // Verify each expected directory exists
    const expectedDirs = [
      paths.installRoot,
      paths.environmentsDir,
      paths.defaultEnvironmentDir,
    ];

    for (const dir of expectedDirs) {
      const dirStat = await stat(dir);
      expect(dirStat.isDirectory()).toBe(true);
    }

    // Verify config file exists
    const configStat = await stat(paths.globalConfigPath);
    expect(configStat.isFile()).toBe(true);
  });

  it("bootstrap directory permissions are 0o700 on Linux", async () => {
    const tempRoot = await createTempDirectory();
    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { paths } = result.value;

    for (const dir of [paths.installRoot, paths.environmentsDir, paths.defaultEnvironmentDir]) {
      const dirStat = await stat(dir);
      expect(dirStat.mode & 0o777).toBe(0o700);
    }
  });

  it("bootstrap config file permissions are 0o600 on Linux", async () => {
    const tempRoot = await createTempDirectory();
    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const configStat = await stat(result.value.paths.globalConfigPath);
    expect(configStat.mode & 0o777).toBe(0o600);
  });

  it("daemon ensureDataDirectories creates all subdirectories", async () => {
    const tempRoot = await createTempDirectory();
    const result = await ensureDataDirectories({
      platform: "linux",
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = result.value;
    const expectedDirs = [
      paths.dataRoot,
      paths.sessionsDir,
      paths.transcriptsDir,
      paths.cronDir,
      paths.gatewayDir,
      paths.logsDir,
    ];

    for (const dir of expectedDirs) {
      const dirStat = await stat(dir);
      expect(dirStat.isDirectory()).toBe(true);
      expect(dirStat.mode & 0o777).toBe(0o700);
    }
  });

  it("daemon subdirectories are children of the data root", async () => {
    const tempRoot = await createTempDirectory();
    const result = await ensureDataDirectories({
      platform: "linux",
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const paths = result.value;
    expect(paths.sessionsDir.startsWith(paths.dataRoot)).toBe(true);
    expect(paths.transcriptsDir.startsWith(paths.dataRoot)).toBe(true);
    expect(paths.cronDir.startsWith(paths.dataRoot)).toBe(true);
    expect(paths.gatewayDir.startsWith(paths.dataRoot)).toBe(true);
    expect(paths.logsDir.startsWith(paths.dataRoot)).toBe(true);
  });
});
