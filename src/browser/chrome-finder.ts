import { homedir } from "node:os";

import { ChromeNotFoundError } from "./errors";

/**
 * File existence check — wrapped for testability.
 * Tests can override via _setFileExistsForTests().
 */
let _fileExists = async (path: string): Promise<boolean> =>
  Bun.file(path).exists();

export function _setFileExistsForTests(
  fn: (path: string) => Promise<boolean>,
): void {
  _fileExists = fn;
}

export function _resetFileExistsForTests(): void {
  _fileExists = async (path: string): Promise<boolean> =>
    Bun.file(path).exists();
}

const MACOS_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  `${homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];

const LINUX_PATHS = [
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome-beta",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/local/bin/chrome",
  "/usr/local/bin/chromium",
  "/snap/bin/chromium",
  "/snap/bin/google-chrome",
  "/opt/google/chrome/chrome",
  "/opt/chromium.org/chromium/chromium",
];

function getWindowsPaths(): string[] {
  const username = process.env.USER ?? process.env.LOGNAME ?? "default";
  return [
    "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
    "/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    `/mnt/c/Users/${username}/AppData/Local/Google/Chrome/Application/chrome.exe`,
  ];
}

async function isWsl(): Promise<boolean> {
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }

  try {
    const content = await Bun.file("/proc/version").text();
    return content.toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

function getCandidatePaths(platform: NodeJS.Platform): string[] {
  if (platform === "darwin") {
    return MACOS_PATHS;
  }

  // Linux includes both native and WSL Windows paths (WSL paths are appended
  // after the async WSL check in findChromeBinary)
  return LINUX_PATHS;
}

async function findFirstExisting(paths: string[]): Promise<string | null> {
  const results = await Promise.allSettled(
    paths.map(async (p) => {
      const exists = await _fileExists(p);
      return { path: p, exists };
    }),
  );

  // Return the first path that exists, preserving priority order
  for (let i = 0; i < paths.length; i++) {
    const result = results[i];
    if (result.status === "fulfilled" && result.value.exists) {
      return result.value.path;
    }
  }

  return null;
}

/**
 * Finds a Chrome or Chromium binary on the current system.
 *
 * Search order:
 * 1. REINS_BROWSER_BINARY env var (validated for existence)
 * 2. Platform-specific well-known paths (checked in parallel)
 *
 * @throws ChromeNotFoundError if no binary is found
 */
export async function findChromeBinary(): Promise<string> {
  // 1. Check env var override first
  const envBinary = process.env.REINS_BROWSER_BINARY;
  if (envBinary) {
    const exists = await _fileExists(envBinary);
    if (exists) {
      return envBinary;
    }
    throw new ChromeNotFoundError(
      `REINS_BROWSER_BINARY is set to "${envBinary}" but the file does not exist. ` +
        `Install Chrome: ${ChromeNotFoundError.installUrl()}`,
    );
  }

  // 2. Platform-specific paths
  const platform = process.platform;
  const candidates = getCandidatePaths(platform);

  // For Linux, also check WSL Windows paths
  if (platform === "linux" && (await isWsl())) {
    const wslPaths = getWindowsPaths();
    const allPaths = [...candidates, ...wslPaths];
    const found = await findFirstExisting(allPaths);
    if (found) {
      return found;
    }
  } else {
    const found = await findFirstExisting(candidates);
    if (found) {
      return found;
    }
  }

  throw new ChromeNotFoundError(
    `Chrome or Chromium binary not found. Searched ${candidates.length} well-known paths. ` +
      `Install Chrome: ${ChromeNotFoundError.installUrl(platform)}`,
  );
}
