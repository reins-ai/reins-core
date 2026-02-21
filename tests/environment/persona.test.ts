import { describe, expect, it } from "bun:test";

import {
  DEFAULT_PERSONA,
  generateDefaultPersonaYaml,
  parsePersonaYaml,
} from "../../src/environment/persona";
import type { EnvironmentDocumentMap } from "../../src/environment/types";
import { SystemPromptBuilder } from "../../src/persona/builder";
import type { Persona as SystemPersona } from "../../src/persona/persona";

function createSystemPersona(): SystemPersona {
  return {
    id: "test-persona",
    name: "Test Persona",
    description: "test",
    systemPrompt: "Base persona prompt.",
    toolPermissions: { mode: "all" },
  };
}

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

describe("SystemPromptBuilder persona.yaml integration", () => {
  it("injects configured persona name into the identity section", () => {
    const builder = new SystemPromptBuilder();
    const environmentDocuments: EnvironmentDocumentMap = {
      PERSONALITY: "You are a helpful assistant.",
      PERSONA: "name: Alex\n",
    };

    const prompt = builder.build({
      persona: createSystemPersona(),
      environmentDocuments,
    });

    expect(prompt).toContain("Your name is Alex.");
    expect(prompt).toContain("You are a helpful assistant.");
  });

  it("does not change identity section when PERSONA document is missing", () => {
    const builder = new SystemPromptBuilder();
    const withoutPersona = builder.build({
      persona: createSystemPersona(),
      environmentDocuments: {
        PERSONALITY: "You are a helpful assistant.",
      },
    });

    const withMissingPersona = builder.build({
      persona: createSystemPersona(),
      environmentDocuments: {
        PERSONALITY: "You are a helpful assistant.",
      },
    });

    expect(withMissingPersona).toBe(withoutPersona);
  });

  it("gracefully ignores invalid PERSONA YAML", () => {
    const builder = new SystemPromptBuilder();
    const baseline = builder.build({
      persona: createSystemPersona(),
      environmentDocuments: {
        PERSONALITY: "You are a helpful assistant.",
      },
    });

    const prompt = builder.build({
      persona: createSystemPersona(),
      environmentDocuments: {
        PERSONALITY: "You are a helpful assistant.",
        PERSONA: "name: [broken",
      },
    });

    expect(prompt).toBe(baseline);
  });

  it("appends persona backstory to the identity section when present", () => {
    const builder = new SystemPromptBuilder();
    const prompt = builder.build({
      persona: createSystemPersona(),
      environmentDocuments: {
        PERSONALITY: "You are a helpful assistant.",
        PERSONA: [
          "name: Alex",
          "backstory: You were built to help users through complex technical decisions.",
          "",
        ].join("\n"),
      },
    });

    expect(prompt).toContain("Your name is Alex.");
    expect(prompt).toContain(
      "You were built to help users through complex technical decisions.",
    );
  });
});
