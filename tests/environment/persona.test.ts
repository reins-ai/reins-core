import { describe, expect, it } from "bun:test";

import {
  DEFAULT_PERSONA,
  generateDefaultPersonaYaml,
  parsePersonaYaml,
} from "../../src/environment/persona";

describe("parsePersonaYaml", () => {
  it("parses valid YAML into a persona object", () => {
    const result = parsePersonaYaml([
      "name: Navigator",
      "backstory: Field specialist",
      "avatar: 🧭",
      "language: fr",
      "ignored: true",
      "",
    ].join("\n"));

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual({
      name: "Navigator",
      backstory: "Field specialist",
      avatar: "🧭",
      language: "fr",
    });
  });

  it("falls back to default persona when YAML is invalid", () => {
    const result = parsePersonaYaml("name: [broken");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual(DEFAULT_PERSONA);
  });

  it("falls back to default persona when content is empty", () => {
    const result = parsePersonaYaml("   ");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual(DEFAULT_PERSONA);
  });

  it("uses defaults for missing optional fields", () => {
    const result = parsePersonaYaml("name: Operator\n");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual({
      name: "Operator",
      avatar: "🤖",
      language: "en",
    });
  });
});

describe("generateDefaultPersonaYaml", () => {
  it("includes the default persona name, avatar, and language", () => {
    const content = generateDefaultPersonaYaml();

    expect(content).toContain("name: Reins");
    expect(content).toContain("avatar: 🤖");
    expect(content).toContain("language: en");
  });
});
