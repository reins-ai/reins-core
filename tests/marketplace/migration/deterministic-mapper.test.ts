import { describe, expect, it } from "bun:test";

import { deterministicMapper } from "../../../src/marketplace/migration/deterministic-mapper";

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected record");
  }

  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("Expected string array");
  }

  return value as string[];
}

describe("deterministicMapper", () => {
  it("maps OpenClaw metadata fields into Reins frontmatter", () => {
    const input = `---
name: test-skill
description: Test description
version: 1.2.3
author: reins
triggers:
  - run test
metadata:
  openclaw:
    emoji: "🔧"
    homepage: https://example.com
    requires:
      env:
        - API_KEY
      bins:
        - node
    os:
      - linux
      - macos
    tags:
      - automation
    config:
      setup_command: npm install
---

# Test Skill

Do work.
`;

    const result = deterministicMapper(input);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const frontmatter = result.value.frontmatter;
    const config = asRecord(frontmatter.config);

    expect(frontmatter.name).toBe("test-skill");
    expect(frontmatter.description).toBe("Test description");
    expect(frontmatter.version).toBe("1.2.3");
    expect(frontmatter.author).toBe("reins");
    expect(frontmatter.trustLevel).toBe("community");
    expect(asStringArray(frontmatter.triggers)).toEqual(["run test"]);
    expect(asStringArray(config.envVars)).toEqual(["API_KEY"]);
    expect(asStringArray(frontmatter.requiredTools)).toEqual(["node"]);
    expect(asStringArray(frontmatter.platforms)).toEqual(["linux", "macos"]);
    expect(asStringArray(frontmatter.categories)).toEqual(["automation"]);
    expect(frontmatter.emoji).toBe("🔧");
    expect(frontmatter.homepage).toBe("https://example.com");

    const openclawMetadata = asRecord(frontmatter.openclawMetadata);
    expect(asRecord(openclawMetadata.config).setup_command).toBe("npm install");
    expect(result.value.report.usedLlm).toBe(false);
  });

  it("resolves clawdbot alias as openclaw metadata", () => {
    const input = `---
name: alias-skill
metadata:
  clawdbot:
    requires:
      env:
        - CLAWDBOT_KEY
---

Alias body.
`;

    const result = deterministicMapper(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const config = asRecord(result.value.frontmatter.config);
      expect(asStringArray(config.envVars)).toEqual(["CLAWDBOT_KEY"]);
    }
  });

  it("resolves clawdis alias as openclaw metadata", () => {
    const input = `---
name: alias-skill
metadata:
  clawdis:
    requires:
      bins:
        - python
---

Alias body.
`;

    const result = deterministicMapper(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(asStringArray(result.value.frontmatter.requiredTools)).toEqual(["python"]);
    }
  });

  it("preserves unmapped openclaw fields under openclawMetadata", () => {
    const input = `---
name: test-skill
metadata:
  openclaw:
    config:
      data_dir: ./data
    custom:
      flag: true
---

Body
`;

    const result = deterministicMapper(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const openclawMetadata = asRecord(result.value.frontmatter.openclawMetadata);
      expect(asRecord(openclawMetadata.config).data_dir).toBe("./data");
      expect(asRecord(openclawMetadata.custom).flag).toBe(true);
      expect(result.value.report.unmappedFields).toContain("metadata.openclaw.config.data_dir");
      expect(result.value.report.unmappedFields).toContain("metadata.openclaw.custom.flag");
    }
  });

  it("preserves markdown body unchanged", () => {
    const input = `---
name: test-skill
---

# Heading

- item one
- item two
`;

    const result = deterministicMapper(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.body).toBe("\n\n# Heading\n\n- item one\n- item two\n");
    }
  });

  it("handles missing optional fields gracefully", () => {
    const input = `---
name: minimal-skill
description: minimal
---

Body
`;

    const result = deterministicMapper(input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.frontmatter.name).toBe("minimal-skill");
      expect(result.value.frontmatter.description).toBe("minimal");
      expect(result.value.frontmatter.requiredTools).toBeUndefined();
      expect(result.value.frontmatter.platforms).toBeUndefined();
      expect(result.value.frontmatter.openclawMetadata).toBeUndefined();
    }
  });
});
