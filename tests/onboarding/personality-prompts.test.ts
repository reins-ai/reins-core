import { describe, expect, it } from "bun:test";

import {
  PERSONALITY_PRESETS,
  getPresetPromptModifier,
} from "../../src/onboarding/personality-prompts";

describe("PERSONALITY_PRESETS", () => {
  it("contains exactly four built-in presets", () => {
    expect(PERSONALITY_PRESETS).toHaveLength(4);
  });

  it("includes balanced, concise, technical, and warm presets", () => {
    const presetNames = PERSONALITY_PRESETS.map((p) => p.preset);
    expect(presetNames).toEqual(["balanced", "concise", "technical", "warm"]);
  });

  it("has non-empty labels for all presets", () => {
    for (const preset of PERSONALITY_PRESETS) {
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });

  it("has non-empty descriptions for all presets", () => {
    for (const preset of PERSONALITY_PRESETS) {
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it("has non-empty system prompt modifiers for all presets", () => {
    for (const preset of PERSONALITY_PRESETS) {
      expect(preset.systemPromptModifier.length).toBeGreaterThan(0);
    }
  });

  it("produces distinct system prompt modifiers for each preset", () => {
    const modifiers = PERSONALITY_PRESETS.map((p) => p.systemPromptModifier);
    const uniqueModifiers = new Set(modifiers);
    expect(uniqueModifiers.size).toBe(PERSONALITY_PRESETS.length);
  });

  it("has no duplicate preset identifiers", () => {
    const presetIds = PERSONALITY_PRESETS.map((p) => p.preset);
    const uniqueIds = new Set(presetIds);
    expect(uniqueIds.size).toBe(PERSONALITY_PRESETS.length);
  });
});

describe("getPresetPromptModifier", () => {
  it("returns the correct modifier for balanced", () => {
    const modifier = getPresetPromptModifier("balanced");
    expect(modifier).toBe(PERSONALITY_PRESETS[0].systemPromptModifier);
  });

  it("returns the correct modifier for concise", () => {
    const modifier = getPresetPromptModifier("concise");
    expect(modifier).toBe(PERSONALITY_PRESETS[1].systemPromptModifier);
  });

  it("returns the correct modifier for technical", () => {
    const modifier = getPresetPromptModifier("technical");
    expect(modifier).toBe(PERSONALITY_PRESETS[2].systemPromptModifier);
  });

  it("returns the correct modifier for warm", () => {
    const modifier = getPresetPromptModifier("warm");
    expect(modifier).toBe(PERSONALITY_PRESETS[3].systemPromptModifier);
  });

  it("returns null for custom preset", () => {
    const modifier = getPresetPromptModifier("custom");
    expect(modifier).toBeNull();
  });

  it("returns a string for every non-custom preset", () => {
    const nonCustomPresets = ["balanced", "concise", "technical", "warm"] as const;
    for (const preset of nonCustomPresets) {
      const modifier = getPresetPromptModifier(preset);
      expect(modifier).toBeTypeOf("string");
      expect(modifier!.length).toBeGreaterThan(0);
    }
  });
});
