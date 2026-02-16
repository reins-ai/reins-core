import { describe, expect, it } from "bun:test";

import {
  MAX_DESCRIPTION_LENGTH,
  MAX_NAME_LENGTH,
  validateMetadata,
} from "../../src/skills/metadata";

describe("validateMetadata", () => {
  it("validates metadata with all supported fields", () => {
    const result = validateMetadata({
      name: "email-automation",
      description: "Automates triage and responses for inbox workflows.",
      triggers: ["email", "inbox triage"],
      requiredTools: ["git", "gh"],
      categories: ["productivity", "communication"],
      trustLevel: "verified",
      config: {
        envVars: ["OPENAI_API_KEY"],
        stateDirs: ["~/.reins/state"],
      },
      platforms: ["macos", "linux"],
      version: "1.2.0",
      author: "Reins Team",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.name).toBe("email-automation");
    expect(result.value.triggers).toEqual(["email", "inbox triage"]);
    expect(result.value.requiredTools).toEqual(["git", "gh"]);
    expect(result.value.categories).toEqual(["productivity", "communication"]);
    expect(result.value.trustLevel).toBe("verified");
    expect(result.value.config).toEqual({
      envVars: ["OPENAI_API_KEY"],
      stateDirs: ["~/.reins/state"],
    });
    expect(result.value.platforms).toEqual(["macos", "linux"]);
    expect(result.value.version).toBe("1.2.0");
    expect(result.value.author).toBe("Reins Team");
  });

  it("validates metadata with only required fields", () => {
    const result = validateMetadata({
      name: "daily-planner",
      description: "Helps plan the day.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value).toEqual({
      name: "daily-planner",
      description: "Helps plan the day.",
      triggers: undefined,
      requiredTools: undefined,
      categories: undefined,
      trustLevel: undefined,
      config: undefined,
      platforms: undefined,
      version: undefined,
      author: undefined,
      extra: undefined,
    });
  });

  it("returns an error when name is missing", () => {
    const result = validateMetadata({
      description: "Has description only",
    });

    expect(result.ok).toBe(false);
  });

  it("returns an error when description is missing", () => {
    const result = validateMetadata({
      name: "skill-name",
    });

    expect(result.ok).toBe(false);
  });

  it("returns an error when name exceeds maximum length", () => {
    const result = validateMetadata({
      name: `a${"b".repeat(MAX_NAME_LENGTH)}`,
      description: "Valid description",
    });

    expect(result.ok).toBe(false);
  });

  it("returns an error when description exceeds maximum length", () => {
    const result = validateMetadata({
      name: "valid-name",
      description: `a${"b".repeat(MAX_DESCRIPTION_LENGTH)}`,
    });

    expect(result.ok).toBe(false);
  });

  it("returns an error for invalid name formats", () => {
    const uppercaseResult = validateMetadata({
      name: "Invalid-Name",
      description: "Valid description",
    });
    const spacedResult = validateMetadata({
      name: "invalid name",
      description: "Valid description",
    });
    const leadingHyphenResult = validateMetadata({
      name: "-invalid",
      description: "Valid description",
    });

    expect(uppercaseResult.ok).toBe(false);
    expect(spacedResult.ok).toBe(false);
    expect(leadingHyphenResult.ok).toBe(false);
  });

  it("returns an error for reserved names", () => {
    const claudeResult = validateMetadata({
      name: "claude-helper",
      description: "Valid description",
    });
    const anthropicResult = validateMetadata({
      name: "anthropic-tool",
      description: "Valid description",
    });

    expect(claudeResult.ok).toBe(false);
    expect(anthropicResult.ok).toBe(false);
  });

  it("preserves unknown fields in extra", () => {
    const result = validateMetadata({
      name: "valid-name",
      description: "Valid description",
      customField: "custom-value",
      nested: { level: 1 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.extra).toEqual({
      customField: "custom-value",
      nested: { level: 1 },
    });
  });

  it("returns an error when triggers is not a string array", () => {
    const result = validateMetadata({
      name: "valid-name",
      description: "Valid description",
      triggers: ["ok", 1],
    });

    expect(result.ok).toBe(false);
  });

  it("returns an error when trustLevel is invalid", () => {
    const result = validateMetadata({
      name: "valid-name",
      description: "Valid description",
      trustLevel: "partial",
    });

    expect(result.ok).toBe(false);
  });
});
