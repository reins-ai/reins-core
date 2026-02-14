import { describe, expect, it } from "bun:test";

import { TRUNCATION_MARKER, truncateSection } from "../../src/persona/truncate";

describe("truncateSection", () => {
  it("returns content unchanged when under budget", () => {
    const content = "Short content.";

    const result = truncateSection(content, 100);

    expect(result).toBe(content);
  });

  it("appends truncation marker when content exceeds budget", () => {
    const longSecondParagraph =
      "Second paragraph with more details repeated for budget overflow. ".repeat(4);
    const content = ["First paragraph.", "", longSecondParagraph].join("\n");

    const result = truncateSection(content, 60);

    expect(result).toContain("[Content truncated — full document available on request]");
    expect(result).toContain(TRUNCATION_MARKER.trim());
    expect(result).not.toBe(content);
  });

  it("truncates at a paragraph boundary when possible", () => {
    const firstParagraph = "Paragraph one is complete.";
    const secondParagraph = "Paragraph two contains additional details beyond the budget.";
    const content = `${firstParagraph}\n\n${secondParagraph}`;
    const budget = firstParagraph.length + TRUNCATION_MARKER.length + 2;

    const result = truncateSection(content, budget);

    expect(result).toBe(`${firstParagraph}${TRUNCATION_MARKER}`);
  });

  it("falls back to a line boundary when paragraph boundary is unavailable", () => {
    const firstLine = "Line one is complete.";
    const secondLine = "Line two continues beyond budget with substantially more content.".repeat(3);
    const content = `${firstLine}\n${secondLine}`;
    const budget = firstLine.length + TRUNCATION_MARKER.length + 1;

    const result = truncateSection(content, budget);

    expect(result).toBe(`${firstLine}${TRUNCATION_MARKER}`);
  });
});
