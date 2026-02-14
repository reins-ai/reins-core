import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bootstrapInstallRoot,
  buildInstallPaths,
  generateDefaultConfigContent,
  resolveInstallRoot,
} from "../../src/environment/bootstrap";

const createdDirectories: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-bootstrap-"));
  createdDirectories.push(directory);
  return directory;
}

describe("resolveInstallRoot", () => {
  it("resolves linux install root to ~/.reins when XDG_DATA_HOME is unset", () => {
    const homeDirectory = "/tmp/reins-home-linux";

    expect(resolveInstallRoot({ platform: "linux", env: {}, homeDirectory })).toBe(
      "/tmp/reins-home-linux/.reins",
    );
  });

  it("resolves linux install root to XDG_DATA_HOME/reins when set", () => {
    const homeDirectory = "/tmp/reins-home-linux";

    expect(
      resolveInstallRoot({
        platform: "linux",
        env: { XDG_DATA_HOME: "/tmp/reins-data" },
        homeDirectory,
      }),
    ).toBe("/tmp/reins-data/reins");
  });

  it("resolves macOS install root to Application Support", () => {
    expect(resolveInstallRoot({ platform: "darwin", homeDirectory: "/Users/reins" })).toBe(
      "/Users/reins/Library/Application Support/reins",
    );
  });

  it("resolves Windows install root to APPDATA", () => {
    expect(
      resolveInstallRoot({
        platform: "win32",
        env: { APPDATA: "C:\\Users\\Reins\\AppData\\Roaming" },
        homeDirectory: "C:\\Users\\Reins",
      }),
    ).toBe("C:\\Users\\Reins\\AppData\\Roaming\\reins");
  });

  it("falls back to ~/.reins for unknown platforms", () => {
    expect(
      resolveInstallRoot({
        platform: "freebsd" as NodeJS.Platform,
        homeDirectory: "/home/user",
      }),
    ).toBe("/home/user/.reins");
  });
});

describe("buildInstallPaths", () => {
  it("returns all expected paths under the install root", () => {
    const paths = buildInstallPaths({
      platform: "linux",
      env: {},
      homeDirectory: "/home/user",
    });

    expect(paths.installRoot).toBe("/home/user/.reins");
    expect(paths.environmentsDir).toBe("/home/user/.reins/environments");
    expect(paths.defaultEnvironmentDir).toBe("/home/user/.reins/environments/default");
    expect(paths.globalConfigPath).toBe("/home/user/.reins/config.json5");
  });

  it("uses platform-specific path separators for Windows", () => {
    const paths = buildInstallPaths({
      platform: "win32",
      env: { APPDATA: "C:\\Users\\Test\\AppData\\Roaming" },
      homeDirectory: "C:\\Users\\Test",
    });

    expect(paths.installRoot).toBe("C:\\Users\\Test\\AppData\\Roaming\\reins");
    expect(paths.environmentsDir).toBe("C:\\Users\\Test\\AppData\\Roaming\\reins\\environments");
    expect(paths.defaultEnvironmentDir).toBe(
      "C:\\Users\\Test\\AppData\\Roaming\\reins\\environments\\default",
    );
    expect(paths.globalConfigPath).toBe(
      "C:\\Users\\Test\\AppData\\Roaming\\reins\\config.json5",
    );
  });
});

describe("generateDefaultConfigContent", () => {
  it("produces valid JSON with a comment header", () => {
    const content = generateDefaultConfigContent();

    expect(content.startsWith("// Reins global configuration (JSON5)\n")).toBe(true);

    const jsonPart = content.split("\n").slice(1).join("\n");
    const parsed = JSON.parse(jsonPart);

    expect(parsed.version).toBe(1);
    expect(parsed.activeEnvironment).toBe("default");
    expect(parsed.heartbeatIntervalMinutes).toBe(30);
  });

  it("includes all required config sections", () => {
    const content = generateDefaultConfigContent();
    const jsonPart = content.split("\n").slice(1).join("\n");
    const parsed = JSON.parse(jsonPart);

    expect(parsed.globalCredentials).toBeDefined();
    expect(parsed.globalCredentials.providerKeys).toEqual({});
    expect(parsed.globalCredentials.gatewayBaseUrl).toBeNull();

    expect(parsed.modelDefaults).toBeDefined();
    expect(parsed.modelDefaults.provider).toBeNull();
    expect(parsed.modelDefaults.model).toBeNull();
    expect(parsed.modelDefaults.temperature).toBe(0.7);
    expect(parsed.modelDefaults.maxTokens).toBe(4096);

    expect(parsed.billing).toBeDefined();
    expect(parsed.billing.mode).toBe("off");
    expect(parsed.billing.monthlySoftLimitUsd).toBeNull();
    expect(parsed.billing.monthlyHardLimitUsd).toBeNull();
    expect(parsed.billing.currencyCode).toBe("USD");
  });
});

describe("bootstrapInstallRoot", () => {
  afterEach(async () => {
    while (createdDirectories.length > 0) {
      const directory = createdDirectories.pop();
      if (!directory) {
        continue;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates install root directory structure", async () => {
    const tempRoot = await createTempDirectory();

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { paths } = result.value;

    const rootStat = await stat(paths.installRoot);
    expect(rootStat.isDirectory()).toBe(true);

    const envsStat = await stat(paths.environmentsDir);
    expect(envsStat.isDirectory()).toBe(true);

    const defaultStat = await stat(paths.defaultEnvironmentDir);
    expect(defaultStat.isDirectory()).toBe(true);
  });

  it("creates directories with secure permissions on non-Windows", async () => {
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

  it("creates default global config file", async () => {
    const tempRoot = await createTempDirectory();

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.configCreated).toBe(true);

    const content = await readFile(result.value.paths.globalConfigPath, "utf8");
    expect(content.startsWith("// Reins global configuration (JSON5)\n")).toBe(true);

    const jsonPart = content.split("\n").slice(1).join("\n");
    const parsed = JSON.parse(jsonPart);
    expect(parsed.version).toBe(1);
    expect(parsed.activeEnvironment).toBe("default");
  });

  it("sets secure file permissions on config file", async () => {
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

  it("is idempotent — running twice produces the same result", async () => {
    const tempRoot = await createTempDirectory();
    const options = {
      platform: "linux" as const,
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    };

    const first = await bootstrapInstallRoot(options);
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    expect(first.value.configCreated).toBe(true);
    expect(first.value.directoriesCreated.length).toBeGreaterThan(0);

    const second = await bootstrapInstallRoot(options);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.value.configCreated).toBe(false);
    expect(second.value.directoriesCreated).toEqual([]);

    expect(second.value.paths.installRoot).toBe(first.value.paths.installRoot);
    expect(second.value.paths.environmentsDir).toBe(first.value.paths.environmentsDir);
    expect(second.value.paths.defaultEnvironmentDir).toBe(first.value.paths.defaultEnvironmentDir);
    expect(second.value.paths.globalConfigPath).toBe(first.value.paths.globalConfigPath);
  });

  it("does not overwrite existing config file on second run", async () => {
    const tempRoot = await createTempDirectory();
    const options = {
      platform: "linux" as const,
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    };

    await bootstrapInstallRoot(options);

    const contentBefore = await readFile(
      buildInstallPaths(options).globalConfigPath,
      "utf8",
    );

    await bootstrapInstallRoot(options);

    const contentAfter = await readFile(
      buildInstallPaths(options).globalConfigPath,
      "utf8",
    );

    expect(contentAfter).toBe(contentBefore);
  });

  it("reports which directories were newly created", async () => {
    const tempRoot = await createTempDirectory();

    const result = await bootstrapInstallRoot({
      platform: "linux",
      env: { XDG_DATA_HOME: tempRoot },
      homeDirectory: tempRoot,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.directoriesCreated).toContain(result.value.paths.installRoot);
    expect(result.value.directoriesCreated).toContain(result.value.paths.environmentsDir);
    expect(result.value.directoriesCreated).toContain(result.value.paths.defaultEnvironmentDir);
  });

  it("returns error when bootstrap fails due to permission issues", async () => {
    const tempRoot = await createTempDirectory();
    const blockingPath = join(tempRoot, "blocked");
    const { writeFile: writeFileFs } = await import("node:fs/promises");
    await writeFileFs(blockingPath, "not a directory", "utf8");

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
});
