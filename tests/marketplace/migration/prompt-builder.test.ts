import { describe, expect, it } from "bun:test";

import { MigrationPromptBuilder } from "../../../src/marketplace/migration/prompt-builder";

describe("MigrationPromptBuilder", () => {
  it("builds a structured migration prompt with required sections", () => {
    const builder = new MigrationPromptBuilder();

    const prompt = builder.buildPrompt(`---\nname: test-skill\n---\n\n# Test Skill\n`);

    expect(prompt).toContain("## Goal");
    expect(prompt).toContain("## Reins SKILL.md requirements");
    expect(prompt).toContain("## Field mapping rules");
    expect(prompt).toContain("metadata.openclaw.requires.env");
    expect(prompt).toContain("config.envVars");
    expect(prompt).toContain("metadata.clawdbot");
    expect(prompt).toContain("metadata.clawdis");
    expect(prompt).toContain("openclawMetadata");
    expect(prompt).toContain("## INTEGRATION.md requirements");
    expect(prompt).toContain("## Output format (strict)");
    expect(prompt).toContain("<skill_md>");
    expect(prompt).toContain("<integration_md>");
    expect(prompt).toContain("## Example");
  });

  it("parses tagged response blocks from LLM output", () => {
    const builder = new MigrationPromptBuilder();
    const parseResponse = builder.buildResponseParser();

    const parsed = parseResponse(`
<skill_md>
---
name: migrated
---

# Migrated
</skill_md>
<integration_md>
null
</integration_md>
`);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.skillMd).toContain("name: migrated");
      expect(parsed.value.integrationMd).toBeNull();
    }
  });
});
