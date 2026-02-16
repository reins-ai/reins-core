import { describe, expect, it } from "bun:test";

import {
  formatSkillIndex,
  getSkillIndexTokenEstimate,
} from "../../src/skills/prompt-formatter";
import type { SkillSummary } from "../../src/skills/types";

describe("formatSkillIndex", () => {
  it("returns empty string for empty summaries", () => {
    expect(formatSkillIndex([])).toBe("");
  });

  it("formats a single skill with preamble", () => {
    const summaries: SkillSummary[] = [
      { name: "git-helper", description: "Assists with git operations" },
    ];

    const result = formatSkillIndex(summaries);

    expect(result).toContain("## Available Skills");
    expect(result).toContain("load_skill");
    expect(result).toContain("- **git-helper**: Assists with git operations");
  });

  it("formats multiple skills in order", () => {
    const summaries: SkillSummary[] = [
      { name: "git-helper", description: "Assists with git operations" },
      { name: "docker-tools", description: "Manages Docker containers" },
      { name: "code-review", description: "Reviews code for quality" },
    ];

    const result = formatSkillIndex(summaries);

    expect(result).toContain("- **git-helper**: Assists with git operations");
    expect(result).toContain("- **docker-tools**: Manages Docker containers");
    expect(result).toContain("- **code-review**: Reviews code for quality");

    const gitIndex = result.indexOf("git-helper");
    const dockerIndex = result.indexOf("docker-tools");
    const reviewIndex = result.indexOf("code-review");
    expect(gitIndex).toBeLessThan(dockerIndex);
    expect(dockerIndex).toBeLessThan(reviewIndex);
  });

  it("includes preamble with load_skill instruction", () => {
    const summaries: SkillSummary[] = [
      { name: "test-skill", description: "A test skill" },
    ];

    const result = formatSkillIndex(summaries);

    expect(result).toContain("## Available Skills");
    expect(result).toContain("load_skill");
    expect(result).toContain("tool");
  });

  it("contains all skill names and descriptions", () => {
    const summaries: SkillSummary[] = [
      { name: "alpha", description: "First skill" },
      { name: "beta", description: "Second skill" },
    ];

    const result = formatSkillIndex(summaries);

    for (const s of summaries) {
      expect(result).toContain(s.name);
      expect(result).toContain(s.description);
    }
  });

  it("produces deterministic output for the same input", () => {
    const summaries: SkillSummary[] = [
      { name: "git-helper", description: "Assists with git operations" },
      { name: "docker-tools", description: "Manages Docker containers" },
    ];

    const first = formatSkillIndex(summaries);
    const second = formatSkillIndex(summaries);

    expect(first).toBe(second);
  });

  it("separates preamble from entries with a blank line", () => {
    const summaries: SkillSummary[] = [
      { name: "test-skill", description: "A test skill" },
    ];

    const result = formatSkillIndex(summaries);
    const lines = result.split("\n");

    const entryLineIndex = lines.findIndex((l) => l.startsWith("- **test-skill**"));
    expect(entryLineIndex).toBeGreaterThan(0);
    expect(lines[entryLineIndex - 1]).toBe("");
  });
});

describe("getSkillIndexTokenEstimate", () => {
  it("returns 0 for empty summaries", () => {
    expect(getSkillIndexTokenEstimate([])).toBe(0);
  });

  it("returns a positive number for populated summaries", () => {
    const summaries: SkillSummary[] = [
      { name: "git-helper", description: "Assists with git operations" },
    ];

    const estimate = getSkillIndexTokenEstimate(summaries);
    expect(estimate).toBeGreaterThan(0);
  });

  it("estimates roughly 100 tokens per skill entry", () => {
    const summaries: SkillSummary[] = [
      { name: "git-helper", description: "Assists with common git operations like branching and merging" },
    ];

    const estimate = getSkillIndexTokenEstimate(summaries);

    // Preamble + one entry should be in a reasonable range
    // Preamble is ~40 tokens, one entry ~20 tokens → ~60 total
    // With generous bounds: 30–150
    expect(estimate).toBeGreaterThan(30);
    expect(estimate).toBeLessThan(150);
  });

  it("scales linearly with number of skills", () => {
    const one: SkillSummary[] = [
      { name: "skill-a", description: "Description for skill A" },
    ];
    const three: SkillSummary[] = [
      { name: "skill-a", description: "Description for skill A" },
      { name: "skill-b", description: "Description for skill B" },
      { name: "skill-c", description: "Description for skill C" },
    ];

    const oneEstimate = getSkillIndexTokenEstimate(one);
    const threeEstimate = getSkillIndexTokenEstimate(three);

    // Three skills should cost more than one
    expect(threeEstimate).toBeGreaterThan(oneEstimate);
    // But not more than 3x (preamble is shared overhead)
    expect(threeEstimate).toBeLessThan(oneEstimate * 3);
  });

  it("uses ceiling for fractional token counts", () => {
    const summaries: SkillSummary[] = [
      { name: "x", description: "y" },
    ];

    const estimate = getSkillIndexTokenEstimate(summaries);
    expect(Number.isInteger(estimate)).toBe(true);
  });
});
