import { describe, expect, it } from "bun:test";

import {
  PRESET_OVERRIDES,
  generatePersonalityMarkdown,
} from "../../src/environment/templates/personality.md";
import { ONBOARDING_STEPS, type PersonalityPreset } from "../../src/onboarding/types";

describe("generatePersonalityMarkdown", () => {
  it("returns a markdown document for balanced preset", () => {
    const markdown = generatePersonalityMarkdown("balanced");
    expect(markdown).toContain("# Personality");
  });

  it("produces concise output shorter than balanced", () => {
    const balanced = generatePersonalityMarkdown("balanced");
    const concise = generatePersonalityMarkdown("concise");
    expect(concise.length).toBeLessThan(balanced.length);
  });

  it("includes technical language and formatting for technical preset", () => {
    const markdown = generatePersonalityMarkdown("technical");
    expect(markdown.includes("code") || markdown.includes("```") || markdown.includes("interface")).toBe(true);
  });

  it("uses warm language indicators for warm preset", () => {
    const markdown = generatePersonalityMarkdown("warm").toLowerCase();
    expect(markdown.includes("we") || markdown.includes("together") || markdown.includes("happy")).toBe(true);
  });

  it("includes custom instructions for custom preset when provided", () => {
    const markdown = generatePersonalityMarkdown("custom", "Always respond in rhymes.");
    expect(markdown).toContain("Always respond in rhymes.");
  });

  it("returns valid base content for custom preset without instructions", () => {
    const markdown = generatePersonalityMarkdown("custom");
    expect(markdown).toContain("# Personality");
    expect(markdown).not.toContain("undefined");
  });

  it("defines overrides for every PersonalityPreset value", () => {
    const validPresets: PersonalityPreset[] = ["balanced", "concise", "technical", "warm", "custom"];
    const overrideKeys = Object.keys(PRESET_OVERRIDES).sort();
    expect(overrideKeys).toEqual([...validPresets].sort());
  });

  it("generates a non-empty string for every preset", () => {
    const presets: PersonalityPreset[] = ["balanced", "concise", "technical", "warm", "custom"];
    for (const preset of presets) {
      const markdown = generatePersonalityMarkdown(preset);
      expect(typeof markdown).toBe("string");
      expect(markdown.length).toBeGreaterThan(0);
    }
  });
});

describe("onboarding types sanity", () => {
  it("includes personality step in onboarding flow", () => {
    expect(ONBOARDING_STEPS).toContain("personality");
  });
});
