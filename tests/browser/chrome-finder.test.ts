import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { ChromeNotFoundError } from "../../src/browser/errors";
import {
  findChromeBinary,
  _setFileExistsForTests,
  _resetFileExistsForTests,
} from "../../src/browser/chrome-finder";

describe("findChromeBinary", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.REINS_BROWSER_BINARY;
    delete process.env.WSL_DISTRO_NAME;
  });

  afterEach(() => {
    _resetFileExistsForTests();
    process.env = { ...originalEnv };
  });

  describe("REINS_BROWSER_BINARY env var", () => {
    it("returns env var path when file exists", async () => {
      process.env.REINS_BROWSER_BINARY = "/custom/path/to/chrome";
      _setFileExistsForTests(async (path) => path === "/custom/path/to/chrome");

      const result = await findChromeBinary();

      expect(result).toBe("/custom/path/to/chrome");
    });

    it("throws ChromeNotFoundError when env var path does not exist", async () => {
      process.env.REINS_BROWSER_BINARY = "/nonexistent/chrome";
      _setFileExistsForTests(async () => false);

      try {
        await findChromeBinary();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ChromeNotFoundError);
        expect((e as ChromeNotFoundError).message).toContain("REINS_BROWSER_BINARY");
        expect((e as ChromeNotFoundError).message).toContain("/nonexistent/chrome");
      }
    });

    it("prioritizes env var over platform paths", async () => {
      process.env.REINS_BROWSER_BINARY = "/env/chrome";
      _setFileExistsForTests(async (path) =>
        path === "/env/chrome" || path === "/usr/bin/google-chrome",
      );

      const result = await findChromeBinary();

      expect(result).toBe("/env/chrome");
    });
  });

  describe("macOS paths", () => {
    it("finds Chrome from macOS application path", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      const macChromePath =
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
      _setFileExistsForTests(async (path) => path === macChromePath);

      try {
        const result = await findChromeBinary();
        expect(result).toBe(macChromePath);
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("finds Chromium when Chrome is not installed on macOS", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

      const chromiumPath =
        "/Applications/Chromium.app/Contents/MacOS/Chromium";
      _setFileExistsForTests(async (path) => path === chromiumPath);

      try {
        const result = await findChromeBinary();
        expect(result).toBe(chromiumPath);
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });
  });

  describe("Linux paths", () => {
    it("finds Chrome from standard Linux path", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      _setFileExistsForTests(async (path) => {
        if (path === "/proc/version") return false;
        return path === "/usr/bin/google-chrome";
      });

      try {
        const result = await findChromeBinary();
        expect(result).toBe("/usr/bin/google-chrome");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("finds chromium-browser when google-chrome is not installed", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      _setFileExistsForTests(async (path) => {
        if (path === "/proc/version") return false;
        return path === "/usr/bin/chromium-browser";
      });

      try {
        const result = await findChromeBinary();
        expect(result).toBe("/usr/bin/chromium-browser");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("finds snap-installed chromium", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });

      _setFileExistsForTests(async (path) => {
        if (path === "/proc/version") return false;
        return path === "/snap/bin/chromium";
      });

      try {
        const result = await findChromeBinary();
        expect(result).toBe("/snap/bin/chromium");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });
  });

  describe("WSL detection", () => {
    it("detects WSL via WSL_DISTRO_NAME and checks Windows paths", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.WSL_DISTRO_NAME = "Ubuntu";

      const windowsChromePath =
        "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
      _setFileExistsForTests(async (path) => path === windowsChromePath);

      try {
        const result = await findChromeBinary();
        expect(result).toBe(windowsChromePath);
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });

    it("prefers Linux paths over WSL Windows paths", async () => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      process.env.WSL_DISTRO_NAME = "Ubuntu";

      _setFileExistsForTests(async (path) =>
        path === "/usr/bin/google-chrome" ||
        path === "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe",
      );

      try {
        const result = await findChromeBinary();
        expect(result).toBe("/usr/bin/google-chrome");
      } finally {
        if (originalPlatform) {
          Object.defineProperty(process, "platform", originalPlatform);
        }
      }
    });
  });

  describe("error handling", () => {
    it("throws ChromeNotFoundError when no binary found", async () => {
      _setFileExistsForTests(async () => false);

      try {
        await findChromeBinary();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ChromeNotFoundError);
        expect((e as ChromeNotFoundError).code).toBe("CHROME_NOT_FOUND");
      }
    });

    it("error message includes install URL", async () => {
      _setFileExistsForTests(async () => false);

      try {
        await findChromeBinary();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ChromeNotFoundError);
        const message = (e as ChromeNotFoundError).message;
        expect(message).toContain("Install Chrome:");
        expect(message).toContain("https://");
      }
    });

    it("error message mentions number of paths searched", async () => {
      _setFileExistsForTests(async () => false);

      try {
        await findChromeBinary();
        expect.unreachable("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(ChromeNotFoundError);
        expect((e as ChromeNotFoundError).message).toContain("well-known paths");
      }
    });
  });
});
