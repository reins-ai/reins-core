import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import { OpenClawDetector } from "../../src/conversion/detector";

interface DetectorFixture {
  detector: OpenClawDetector;
}

function createDetectorFixture(options: {
  platform: NodeJS.Platform;
  homeDirectory?: string;
  env?: NodeJS.ProcessEnv;
  existingPaths?: string[];
  files?: Record<string, string>;
}): DetectorFixture {
  const existingPaths = new Set(options.existingPaths ?? []);
  const files = options.files ?? {};

  const detector = new OpenClawDetector({
    platform: options.platform,
    homeDirectory: options.homeDirectory ?? "/home/testuser",
    env: options.env ?? {},
    fileExistsFn: async (path) => existingPaths.has(path),
    readFileFn: async (path) => files[path] ?? null,
  });

  return { detector };
}

describe("OpenClawDetector", () => {
  it("uses OPENCLAW_STATE_DIR override when provided", async () => {
    const overridePath = "/tmp/fake-openclaw";
    const { detector } = createDetectorFixture({
      platform: "linux",
      env: { OPENCLAW_STATE_DIR: overridePath },
      existingPaths: [overridePath],
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(overridePath);
    expect(result.platform).toBe("linux");
  });

  it("prefers env override over platform-specific macOS paths", async () => {
    const homeDirectory = "/Users/testuser";
    const overridePath = "/custom/openclaw";
    const macPrimaryPath = join(
      homeDirectory,
      "Library",
      "Application Support",
      "openclaw",
    );

    const { detector } = createDetectorFixture({
      platform: "darwin",
      homeDirectory,
      env: { OPENCLAW_STATE_DIR: overridePath },
      existingPaths: [overridePath, macPrimaryPath],
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(overridePath);
    expect(result.platform).toBe("macos");
  });

  it("uses macOS primary path when available", async () => {
    const homeDirectory = "/Users/testuser";
    const macPrimaryPath = join(
      homeDirectory,
      "Library",
      "Application Support",
      "openclaw",
    );

    const { detector } = createDetectorFixture({
      platform: "darwin",
      homeDirectory,
      existingPaths: [macPrimaryPath],
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(macPrimaryPath);
    expect(result.platform).toBe("macos");
  });

  it("falls back to ~/.openclaw on macOS when primary path is missing", async () => {
    const homeDirectory = "/Users/testuser";
    const fallbackPath = join(homeDirectory, ".openclaw");

    const { detector } = createDetectorFixture({
      platform: "darwin",
      homeDirectory,
      existingPaths: [fallbackPath],
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(fallbackPath);
    expect(result.platform).toBe("macos");
  });

  it("detects native Linux path and reports linux platform", async () => {
    const linuxPath = "/home/testuser/.openclaw";
    const { detector } = createDetectorFixture({
      platform: "linux",
      homeDirectory: "/home/testuser",
      existingPaths: [linuxPath],
      files: {
        "/proc/version": "Linux version 6.8.0",
      },
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(linuxPath);
    expect(result.platform).toBe("linux");
  });

  it("reports wsl2 platform when /proc/version contains Microsoft", async () => {
    const linuxPath = "/home/testuser/.openclaw";
    const { detector } = createDetectorFixture({
      platform: "linux",
      homeDirectory: "/home/testuser",
      existingPaths: [linuxPath],
      files: {
        "/proc/version": "Linux version 5.15.90.1-microsoft-standard-WSL2 Microsoft",
      },
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(linuxPath);
    expect(result.platform).toBe("wsl2");
  });

  it("detects Windows path using USERPROFILE", async () => {
    const userProfile = "C:\\Users\\testuser";
    const windowsPath = join(userProfile, ".openclaw");

    const { detector } = createDetectorFixture({
      platform: "win32",
      env: { USERPROFILE: userProfile },
      existingPaths: [windowsPath],
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(windowsPath);
    expect(result.platform).toBe("windows");
  });

  it("returns not-found result when no candidate path exists", async () => {
    const { detector } = createDetectorFixture({
      platform: "linux",
      homeDirectory: "/home/testuser",
    });

    const result = await detector.detect();

    expect(result.found).toBe(false);
    expect(result.path).toBe("");
    expect(result.version).toBeUndefined();
    expect(result.platform).toBe("linux");
  });

  it("extracts version from openclaw.json when available", async () => {
    const openClawPath = "/home/testuser/.openclaw";
    const configPath = join(openClawPath, "openclaw.json");

    const { detector } = createDetectorFixture({
      platform: "linux",
      homeDirectory: "/home/testuser",
      existingPaths: [openClawPath],
      files: {
        [configPath]: JSON.stringify({
          meta: {
            lastTouchedVersion: "2026.2.3-1",
          },
        }),
      },
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.version).toBe("2026.2.3-1");
  });

  it("handles missing openclaw.json without crashing", async () => {
    const openClawPath = "/home/testuser/.openclaw";
    const { detector } = createDetectorFixture({
      platform: "linux",
      homeDirectory: "/home/testuser",
      existingPaths: [openClawPath],
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.version).toBeUndefined();
  });

  it("extracts version for OPENCLAW_STATE_DIR path when config exists", async () => {
    const overridePath = "/custom/openclaw";
    const configPath = join(overridePath, "openclaw.json");

    const { detector } = createDetectorFixture({
      platform: "linux",
      env: { OPENCLAW_STATE_DIR: overridePath },
      existingPaths: [overridePath],
      files: {
        [configPath]: JSON.stringify({
          meta: {
            lastTouchedVersion: "2026.2.3-1",
          },
        }),
      },
    });

    const result = await detector.detect();

    expect(result.found).toBe(true);
    expect(result.path).toBe(overridePath);
    expect(result.version).toBe("2026.2.3-1");
  });
});
