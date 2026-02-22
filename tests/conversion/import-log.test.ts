import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ImportLogWriter,
  type ImportLogEntry,
} from "../../src/conversion/import-log";

function createTmpOutputPath(): string {
  const id = Math.random().toString(36).slice(2, 10);
  return join(tmpdir(), `reins-test-import-log-${id}`, "IMPORT_LOG.md");
}

describe("ImportLogWriter", () => {
  let outputPath: string;
  let writer: ImportLogWriter;

  beforeEach(() => {
    outputPath = createTmpOutputPath();
    writer = new ImportLogWriter({ outputPath });
  });

  afterEach(async () => {
    const dir = join(outputPath, "..");
    try {
      await rm(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  describe("addEntry", () => {
    it("accumulates entries and reports count", () => {
      expect(writer.entryCount).toBe(0);

      writer.addEntry({
        path: "gateway.port",
        originalValue: 8080,
        isSecret: false,
        reason: "No equivalent in Reins",
        category: "gateway",
      });

      expect(writer.entryCount).toBe(1);

      writer.addEntry({
        path: "gateway.authMode",
        originalValue: "bearer",
        isSecret: false,
        reason: "Reins uses a different auth model",
        category: "gateway",
      });

      expect(writer.entryCount).toBe(2);
    });
  });

  describe("clear", () => {
    it("resets all accumulated entries", () => {
      writer.addEntry({
        path: "gateway.port",
        originalValue: 8080,
        isSecret: false,
        reason: "No equivalent",
        category: "gateway",
      });

      expect(writer.entryCount).toBe(1);
      writer.clear();
      expect(writer.entryCount).toBe(0);
    });
  });

  describe("render", () => {
    it("renders header with timestamp", () => {
      const content = writer.render();

      expect(content).toContain("# Reins Import Log");
      expect(content).toContain("**Generated:**");
    });

    it("renders empty state message when no entries", () => {
      const content = writer.render();

      expect(content).toContain("No unmapped data found during conversion.");
      expect(content).not.toContain("| Path |");
    });

    it("renders entries in a Markdown table grouped by category", () => {
      writer.addEntry({
        path: "gateway.port",
        originalValue: 8080,
        isSecret: false,
        reason: "No equivalent in Reins",
        category: "gateway",
      });

      writer.addEntry({
        path: "gateway.authMode",
        originalValue: "bearer",
        isSecret: false,
        reason: "Reins uses a different auth model",
        category: "gateway",
      });

      const content = writer.render();

      expect(content).toContain("## gateway");
      expect(content).toContain("| Path | Value | Reason |");
      expect(content).toContain("| --- | --- | --- |");
      expect(content).toContain("| gateway.port | 8080 | No equivalent in Reins |");
      expect(content).toContain(
        "| gateway.authMode | bearer | Reins uses a different auth model |",
      );
    });

    it("groups entries by category with sorted category headings", () => {
      writer.addEntry({
        path: "gateway.port",
        originalValue: 8080,
        isSecret: false,
        reason: "No equivalent",
        category: "gateway",
      });

      writer.addEntry({
        path: "browser.headless",
        originalValue: true,
        isSecret: false,
        reason: "Browser config not supported",
        category: "browser",
      });

      writer.addEntry({
        path: "gateway.tailscale",
        originalValue: { enabled: true },
        isSecret: false,
        reason: "Tailscale integration not supported",
        category: "gateway",
      });

      const content = writer.render();

      // browser comes before gateway alphabetically
      const browserIndex = content.indexOf("## browser");
      const gatewayIndex = content.indexOf("## gateway");
      expect(browserIndex).toBeGreaterThan(-1);
      expect(gatewayIndex).toBeGreaterThan(-1);
      expect(browserIndex).toBeLessThan(gatewayIndex);

      // gateway section has two entries
      const gatewaySection = content.slice(gatewayIndex);
      expect(gatewaySection).toContain("gateway.port");
      expect(gatewaySection).toContain("gateway.tailscale");
    });

    it("redacts secret values with [REDACTED]", () => {
      writer.addEntry({
        path: "gateway.authToken",
        originalValue: "sk-super-secret-token-12345",
        isSecret: true,
        reason: "Stored via keychain instead",
        category: "gateway",
      });

      const content = writer.render();

      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain("sk-super-secret-token-12345");
    });

    it("displays non-secret values as-is", () => {
      writer.addEntry({
        path: "gateway.port",
        originalValue: 3000,
        isSecret: false,
        reason: "No equivalent",
        category: "gateway",
      });

      const content = writer.render();

      expect(content).toContain("| gateway.port | 3000 | No equivalent |");
    });

    it("formats object values as JSON", () => {
      writer.addEntry({
        path: "gateway.tailscale",
        originalValue: { enabled: true, hostname: "my-host" },
        isSecret: false,
        reason: "Not supported",
        category: "gateway",
      });

      const content = writer.render();

      expect(content).toContain(
        JSON.stringify({ enabled: true, hostname: "my-host" }),
      );
    });

    it("formats null and undefined values", () => {
      writer.addEntry({
        path: "gateway.nullField",
        originalValue: null,
        isSecret: false,
        reason: "Null value",
        category: "gateway",
      });

      writer.addEntry({
        path: "gateway.undefinedField",
        originalValue: undefined,
        isSecret: false,
        reason: "Undefined value",
        category: "gateway",
      });

      const content = writer.render();

      expect(content).toContain("| gateway.nullField | null | Null value |");
      expect(content).toContain(
        "| gateway.undefinedField | undefined | Undefined value |",
      );
    });

    it("formats boolean values", () => {
      writer.addEntry({
        path: "browser.headless",
        originalValue: true,
        isSecret: false,
        reason: "Not supported",
        category: "browser",
      });

      const content = writer.render();

      expect(content).toContain("| browser.headless | true | Not supported |");
    });

    it("escapes pipe characters in values", () => {
      writer.addEntry({
        path: "config.pattern",
        originalValue: "a|b|c",
        isSecret: false,
        reason: "Pattern not supported",
        category: "misc",
      });

      const content = writer.render();

      expect(content).toContain("a\\|b\\|c");
      // Should not break the table structure
      const tableLines = content
        .split("\n")
        .filter((line) => line.startsWith("| config.pattern"));
      expect(tableLines.length).toBe(1);
    });

    it("escapes newlines in values", () => {
      writer.addEntry({
        path: "config.multiline",
        originalValue: "line1\nline2",
        isSecret: false,
        reason: "Multiline not supported",
        category: "misc",
      });

      const content = writer.render();

      expect(content).toContain("line1 line2");
      expect(content).not.toContain("line1\nline2");
    });

    it("includes total unmapped entries count", () => {
      writer.addEntry({
        path: "a.b",
        originalValue: 1,
        isSecret: false,
        reason: "r",
        category: "cat",
      });

      writer.addEntry({
        path: "c.d",
        originalValue: 2,
        isSecret: false,
        reason: "r",
        category: "cat",
      });

      const content = writer.render();

      expect(content).toContain("**Total unmapped entries:** 2");
    });
  });

  describe("write", () => {
    it("writes the log file to the specified output path", async () => {
      writer.addEntry({
        path: "gateway.port",
        originalValue: 8080,
        isSecret: false,
        reason: "No equivalent in Reins",
        category: "gateway",
      });

      const result = await writer.write();

      expect(result.ok).toBe(true);

      const file = Bun.file(outputPath);
      expect(await file.exists()).toBe(true);

      const content = await file.text();
      expect(content).toContain("# Reins Import Log");
      expect(content).toContain("gateway.port");
    });

    it("creates parent directories if they do not exist", async () => {
      const deepPath = join(
        tmpdir(),
        `reins-test-deep-${Math.random().toString(36).slice(2, 8)}`,
        "nested",
        "dir",
        "IMPORT_LOG.md",
      );

      const deepWriter = new ImportLogWriter({ outputPath: deepPath });
      deepWriter.addEntry({
        path: "test.field",
        originalValue: "value",
        isSecret: false,
        reason: "test",
        category: "test",
      });

      const result = await deepWriter.write();

      expect(result.ok).toBe(true);

      const file = Bun.file(deepPath);
      expect(await file.exists()).toBe(true);

      // Cleanup
      const rootDir = join(
        tmpdir(),
        deepPath.split("/").find((s) => s.startsWith("reins-test-deep-"))!,
      );
      await rm(rootDir, { recursive: true, force: true });
    });

    it("writes empty state message when no entries", async () => {
      const result = await writer.write();

      expect(result.ok).toBe(true);

      const content = await Bun.file(outputPath).text();
      expect(content).toContain("No unmapped data found during conversion.");
    });

    it("returns error result on write failure", async () => {
      // Use an invalid path that cannot be created
      const badWriter = new ImportLogWriter({
        outputPath: "/proc/nonexistent/impossible/IMPORT_LOG.md",
      });

      badWriter.addEntry({
        path: "test",
        originalValue: "val",
        isSecret: false,
        reason: "test",
        category: "test",
      });

      const result = await badWriter.write();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("IMPORT_LOG_ERROR");
        expect(result.error.message).toContain("Failed to write import log");
      }
    });

    it("redacts secrets in the written file", async () => {
      writer.addEntry({
        path: "auth.apiKey",
        originalValue: "sk-secret-key-abc123",
        isSecret: true,
        reason: "Stored in keychain",
        category: "auth",
      });

      writer.addEntry({
        path: "auth.provider",
        originalValue: "openai",
        isSecret: false,
        reason: "Different config format",
        category: "auth",
      });

      await writer.write();

      const content = await Bun.file(outputPath).text();

      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain("sk-secret-key-abc123");
      expect(content).toContain("openai");
    });
  });

  describe("default output path", () => {
    it("defaults to ~/.reins/IMPORT_LOG.md when no outputPath given", () => {
      const defaultWriter = new ImportLogWriter();
      const content = defaultWriter.render();

      // Just verify it can render — we don't write to the real home dir
      expect(content).toContain("# Reins Import Log");
    });
  });
});
