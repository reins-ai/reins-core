import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "bun:test";

import {
  BANNED_COMMANDS,
  isBannedCommand,
  isSafeRelativePath,
  validateCommand,
  validatePath,
} from "../../src/tools/system";
import { SYSTEM_TOOL_ERROR_CODES } from "../../src/tools/system/types";

describe("validatePath", () => {
  it("allows paths within sandbox root", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "reins-sandbox-"));

    try {
      const result = validatePath("src/tools/file.ts", sandboxRoot);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value).toBe(resolve(sandboxRoot, "src/tools/file.ts"));
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("rejects absolute paths outside sandbox", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "reins-sandbox-"));

    try {
      const result = validatePath("/etc/passwd", sandboxRoot);

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
      expect(result.error.retryable).toBe(false);
      expect(result.error.details).toEqual({
        attemptedPath: "/etc/passwd",
        sandboxRoot,
        reason: "path_outside_sandbox",
      });
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("rejects relative traversal escapes", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "reins-sandbox-"));

    try {
      const result = validatePath("../../../etc/passwd", sandboxRoot);

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
      expect(result.error.details?.["reason"]).toBe("path_outside_sandbox");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("rejects traversal attempts in the middle of a path", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "reins-sandbox-"));

    try {
      const result = validatePath("safe/../../../etc", sandboxRoot);

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
      expect(result.error.details?.["reason"]).toBe("path_outside_sandbox");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("rejects symlink escape attempts", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "reins-sandbox-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "reins-outside-"));

    try {
      mkdirSync(join(sandboxRoot, "links"));
      writeFileSync(join(outsideRoot, "secret.txt"), "sensitive");
      symlinkSync(outsideRoot, join(sandboxRoot, "links", "external"), "dir");

      const result = validatePath("links/external/secret.txt", sandboxRoot);

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
      expect(result.error.details?.["reason"]).toBe("resolved_path_outside_sandbox");
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  it("normalizes paths with dots, duplicate separators, and trailing slash", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "reins-sandbox-"));

    try {
      const result = validatePath("./nested//file.txt/", `${sandboxRoot}/`);

      expect(result.ok).toBe(true);
      if (!result.ok) {
        return;
      }

      expect(result.value).toBe(resolve(sandboxRoot, "nested/file.txt"));
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("rejects empty paths with a structured permission error", () => {
    const sandboxRoot = mkdtempSync(join(tmpdir(), "reins-sandbox-"));

    try {
      const result = validatePath("   ", sandboxRoot);

      expect(result.ok).toBe(false);
      if (result.ok) {
        return;
      }

      expect(result.error.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
      expect(result.error.retryable).toBe(false);
      expect(result.error.details).toEqual({
        attemptedPath: "   ",
        sandboxRoot,
        reason: "empty_path",
      });
    } finally {
      rmSync(sandboxRoot, { recursive: true, force: true });
    }
  });
});

describe("isSafeRelativePath", () => {
  it("accepts clean relative paths", () => {
    expect(isSafeRelativePath("src/tools/system/sandbox.ts")).toBe(true);
  });

  it("rejects traversal segments and absolute paths", () => {
    expect(isSafeRelativePath("../../etc/passwd")).toBe(false);
    expect(isSafeRelativePath("src/../secrets.env")).toBe(false);
    expect(isSafeRelativePath("/etc/passwd")).toBe(false);
    expect(isSafeRelativePath("C:\\Windows\\System32\\drivers\\etc\\hosts")).toBe(false);
  });
});

describe("command policy", () => {
  it("allows safe commands", () => {
    const commands = ["ls", "git status", "bun test"];

    for (const command of commands) {
      const result = validateCommand(command);
      expect(result.ok).toBe(true);
    }
  });

  it("rejects banned commands with structured permission errors", () => {
    const result = validateCommand("sudo rm -rf /tmp/test");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.code).toBe(SYSTEM_TOOL_ERROR_CODES.TOOL_PERMISSION_DENIED);
    expect(result.error.retryable).toBe(false);
    expect(result.error.details?.["command"]).toBe("sudo rm -rf /tmp/test");
    expect(BANNED_COMMANDS).toContain(result.error.details?.["matchedPattern"]);
    expect(result.error.details?.["reason"]).toBe("banned_command");
  });

  it("enforces case-insensitive matching", () => {
    const result = validateCommand("MKFS /dev/sda");

    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }

    expect(result.error.details?.["matchedPattern"]).toBe("mkfs");
  });

  it("supports substring matching for dangerous patterns", () => {
    expect(isBannedCommand("echo prep && rm -rf / && echo done")).toBe(true);
  });

  it("blocks su command variants", () => {
    expect(isBannedCommand("su")).toBe(true);
    expect(isBannedCommand("su root")).toBe(true);
  });

  it("exports a non-empty banned command list", () => {
    expect(BANNED_COMMANDS.length).toBeGreaterThan(0);
  });
});
