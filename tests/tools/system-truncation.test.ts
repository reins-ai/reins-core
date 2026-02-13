import { describe, expect, it } from "bun:test";

import {
  MAX_BYTES,
  MAX_LINES,
  truncateOutput,
} from "../../src/tools/system/truncation";

describe("truncateOutput", () => {
  it("returns full text when input is under the limit", () => {
    const result = truncateOutput("short text", { maxLines: 100, maxBytes: 100 });

    expect(result).toEqual({
      output: "short text",
      metadata: {
        truncated: false,
        originalLines: 1,
        originalBytes: 10,
      },
    });
  });

  it("does not truncate when exactly at both default limits", () => {
    const exactLineBlock = `${"a\n".repeat(MAX_LINES - 1)}b`;
    const exactByteBlock = "x".repeat(MAX_BYTES);

    const lineResult = truncateOutput(exactLineBlock);
    const byteResult = truncateOutput(exactByteBlock);

    expect(lineResult.metadata.truncated).toBe(false);
    expect(lineResult.output).toBe(exactLineBlock);

    expect(byteResult.metadata.truncated).toBe(false);
    expect(byteResult.output).toBe(exactByteBlock);
  });

  it("truncates by line count when over MAX_LINES", () => {
    const content = ["line-1", "line-2", "line-3", "line-4"].join("\n");
    const result = truncateOutput(content, { maxLines: 2, maxBytes: 1024 });

    expect(result.output).toBe("line-1\nline-2");
    expect(result.metadata).toEqual({
      truncated: true,
      originalLines: 4,
      originalBytes: new TextEncoder().encode(content).byteLength,
    });
  });

  it("truncates by byte count when over MAX_BYTES", () => {
    const result = truncateOutput("abcdefgh", { maxLines: 10, maxBytes: 5 });

    expect(result.output).toBe("abcde");
    expect(result.metadata).toEqual({
      truncated: true,
      originalLines: 1,
      originalBytes: 8,
    });
  });

  it("handles Unicode without splitting multi-byte characters", () => {
    const content = "A🙂B";
    const fullBytes = new TextEncoder().encode(content).byteLength;
    const result = truncateOutput(content, { maxLines: 10, maxBytes: 5 });

    expect(fullBytes).toBe(6);
    expect(result.output).toBe("A🙂");
    expect(result.metadata).toEqual({
      truncated: true,
      originalLines: 1,
      originalBytes: 6,
    });
  });

  it("handles empty input", () => {
    const result = truncateOutput("");

    expect(result).toEqual({
      output: "",
      metadata: {
        truncated: false,
        originalLines: 0,
        originalBytes: 0,
      },
    });
  });

  it("uses custom limits deterministically", () => {
    const content = "l1\nl2\nl3";
    const byLine = truncateOutput(content, { maxLines: 1, maxBytes: 1024 });
    const byByte = truncateOutput(content, { maxLines: 10, maxBytes: 2 });

    expect(byLine.output).toBe("l1");
    expect(byLine.metadata.truncated).toBe(true);

    expect(byByte.output).toBe("l1");
    expect(byByte.metadata.truncated).toBe(true);
  });

  it("falls back to defaults for invalid custom limits", () => {
    const longText = "x".repeat(MAX_BYTES + 10);
    const result = truncateOutput(longText, { maxLines: Number.NaN, maxBytes: Number.NaN });

    expect(result.output.length).toBe(MAX_BYTES);
    expect(result.metadata.truncated).toBe(true);
    expect(result.metadata.originalBytes).toBe(MAX_BYTES + 10);
  });
});
