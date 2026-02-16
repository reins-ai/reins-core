import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";

import { parseSkillMd, parseYamlFrontmatter, readSkillMd } from "../../src/skills/parser";
import { SkillError, SKILL_ERROR_CODES } from "../../src/skills/errors";

const VALID_FULL_SKILL = `---
name: email-automation
description: Automates triage and responses for inbox workflows
triggers:
  - help with email
  - send email
  - inbox triage
requiredTools:
  - git
  - gh
categories:
  - productivity
  - communication
trustLevel: trusted
config:
  envVars:
    - GMAIL_API_KEY
    - SMTP_HOST
  stateDirs:
    - ~/.reins/state/email
platforms:
  - macos
  - linux
version: 1.0.0
author: Reins Team
---

# Email Automation

This skill helps you manage your email inbox.

## Workflows

### Triage
Automatically categorize incoming emails.

### Reply
Draft responses based on context.
`;

const VALID_MINIMAL_SKILL = `---
name: daily-planner
description: Helps plan the day
---

# Daily Planner

Plan your day effectively.
`;

const VALID_MINIMAL_NO_BODY = `---
name: empty-body
description: A skill with no body content
---
`;

const VALID_WITH_EXTRA_FIELDS = `---
name: extended-skill
description: A skill with unknown fields
customField: custom-value
priority: high
---

# Extended Skill

Body content here.
`;

const VALID_INLINE_ARRAYS = `---
name: inline-skill
description: A skill with inline arrays
triggers: [email, inbox, triage]
categories: [productivity]
---

# Inline Skill

Body.
`;

const VALID_QUOTED_VALUES = `---
name: quoted-skill
description: "A skill with quoted description"
version: '2.0.0'
author: "Jane Doe"
---

# Quoted Skill

Body.
`;

describe("parseYamlFrontmatter", () => {
  it("parses simple key-value pairs", () => {
    const result = parseYamlFrontmatter("name: my-skill\ndescription: A helpful skill");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value).toEqual({
      name: "my-skill",
      description: "A helpful skill",
    });
  });

  it("parses block arrays", () => {
    const yaml = "triggers:\n  - email\n  - inbox\n  - triage";
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.triggers).toEqual(["email", "inbox", "triage"]);
  });

  it("parses inline arrays", () => {
    const yaml = "categories: [productivity, communication]";
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.categories).toEqual(["productivity", "communication"]);
  });

  it("parses empty inline arrays", () => {
    const yaml = "triggers: []";
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.triggers).toEqual([]);
  });

  it("parses nested objects with array values", () => {
    const yaml = "config:\n  envVars:\n    - VAR1\n    - VAR2\n  stateDirs:\n    - /tmp";
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.config).toEqual({
      envVars: ["VAR1", "VAR2"],
      stateDirs: ["/tmp"],
    });
  });

  it("parses quoted string values", () => {
    const yaml = 'name: "my-skill"\ndescription: \'A helpful skill\'';
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe("my-skill");
    expect(result.value.description).toBe("A helpful skill");
  });

  it("skips empty lines and comments", () => {
    const yaml = "# This is a comment\nname: my-skill\n\n# Another comment\ndescription: A skill";
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe("my-skill");
    expect(result.value.description).toBe("A skill");
  });

  it("returns error for missing colon", () => {
    const yaml = "name my-skill";
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("missing colon");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("returns error for unexpected indentation", () => {
    const yaml = "  indented: value";
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("unexpected indentation");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("returns error for unclosed inline array", () => {
    const yaml = "triggers: [email, inbox";
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("unclosed inline array");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("handles mixed scalar and array fields", () => {
    const yaml = "name: my-skill\ntriggers:\n  - email\ndescription: A skill\ncategories: [dev]";
    const result = parseYamlFrontmatter(yaml);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.name).toBe("my-skill");
    expect(result.value.triggers).toEqual(["email"]);
    expect(result.value.description).toBe("A skill");
    expect(result.value.categories).toEqual(["dev"]);
  });
});

describe("parseSkillMd", () => {
  it("parses a valid SKILL.md with full frontmatter and body", () => {
    const result = parseSkillMd(VALID_FULL_SKILL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.name).toBe("email-automation");
    expect(result.value.metadata.description).toBe("Automates triage and responses for inbox workflows");
    expect(result.value.metadata.triggers).toEqual(["help with email", "send email", "inbox triage"]);
    expect(result.value.metadata.requiredTools).toEqual(["git", "gh"]);
    expect(result.value.metadata.categories).toEqual(["productivity", "communication"]);
    expect(result.value.metadata.trustLevel).toBe("trusted");
    expect(result.value.metadata.config).toEqual({
      envVars: ["GMAIL_API_KEY", "SMTP_HOST"],
      stateDirs: ["~/.reins/state/email"],
    });
    expect(result.value.metadata.platforms).toEqual(["macos", "linux"]);
    expect(result.value.metadata.version).toBe("1.0.0");
    expect(result.value.metadata.author).toBe("Reins Team");
    expect(result.value.body).toContain("# Email Automation");
    expect(result.value.body).toContain("### Triage");
    expect(result.value.raw).toBe(VALID_FULL_SKILL);
  });

  it("parses a valid SKILL.md with minimal frontmatter", () => {
    const result = parseSkillMd(VALID_MINIMAL_SKILL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.name).toBe("daily-planner");
    expect(result.value.metadata.description).toBe("Helps plan the day");
    expect(result.value.metadata.triggers).toBeUndefined();
    expect(result.value.metadata.requiredTools).toBeUndefined();
    expect(result.value.body).toContain("# Daily Planner");
  });

  it("parses a SKILL.md with empty body", () => {
    const result = parseSkillMd(VALID_MINIMAL_NO_BODY);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.name).toBe("empty-body");
    expect(result.value.body).toBe("");
  });

  it("preserves unknown YAML fields in metadata.extra", () => {
    const result = parseSkillMd(VALID_WITH_EXTRA_FIELDS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.extra).toEqual({
      customField: "custom-value",
      priority: "high",
    });
  });

  it("parses inline array syntax", () => {
    const result = parseSkillMd(VALID_INLINE_ARRAYS);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.triggers).toEqual(["email", "inbox", "triage"]);
    expect(result.value.metadata.categories).toEqual(["productivity"]);
  });

  it("handles quoted values in frontmatter", () => {
    const result = parseSkillMd(VALID_QUOTED_VALUES);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.description).toBe("A skill with quoted description");
    expect(result.value.metadata.version).toBe("2.0.0");
    expect(result.value.metadata.author).toBe("Jane Doe");
  });

  it("returns error when content is empty", () => {
    const result = parseSkillMd("");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("empty");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("returns error when content is only whitespace", () => {
    const result = parseSkillMd("   \n\n  ");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("empty");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("returns error when opening frontmatter delimiter is missing", () => {
    const result = parseSkillMd("name: my-skill\ndescription: A skill\n---\n\n# Body");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("must start with YAML frontmatter delimiters");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("returns error when closing frontmatter delimiter is missing", () => {
    const result = parseSkillMd("---\nname: my-skill\ndescription: A skill\n\n# Body without closing");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("missing closing frontmatter delimiter");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("returns error when frontmatter is empty between delimiters", () => {
    const result = parseSkillMd("---\n---\n\n# Body");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("frontmatter is empty");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("returns error when frontmatter has only whitespace between delimiters", () => {
    const result = parseSkillMd("---\n  \n  \n---\n\n# Body");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("frontmatter is empty");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("returns validation error when required name field is missing", () => {
    const content = "---\ndescription: A skill without a name\n---\n\n# Body";
    const result = parseSkillMd(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("name");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.VALIDATION);
  });

  it("returns validation error when required description field is missing", () => {
    const content = "---\nname: my-skill\n---\n\n# Body";
    const result = parseSkillMd(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("description");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.VALIDATION);
  });

  it("returns validation error for invalid name format", () => {
    const content = "---\nname: Invalid-Name\ndescription: A skill\n---\n\n# Body";
    const result = parseSkillMd(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("name");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.VALIDATION);
  });

  it("returns error for invalid YAML in frontmatter", () => {
    const content = "---\nname: my-skill\n  bad indentation here\n---\n\n# Body";
    const result = parseSkillMd(content);

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
  });

  it("stores the raw content in the result", () => {
    const result = parseSkillMd(VALID_MINIMAL_SKILL);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.raw).toBe(VALID_MINIMAL_SKILL);
  });

  it("handles frontmatter with trailing newline before closing delimiter", () => {
    const content = "---\nname: my-skill\ndescription: A skill\n\n---\n\n# Body";
    const result = parseSkillMd(content);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.metadata.name).toBe("my-skill");
    expect(result.value.body).toBe("# Body");
  });
});

describe("readSkillMd", () => {
  const tmpDir = join(import.meta.dir, ".tmp-parser-test");

  async function setup() {
    await mkdir(tmpDir, { recursive: true });
  }

  async function teardown() {
    await rm(tmpDir, { recursive: true, force: true });
  }

  it("reads and parses a valid SKILL.md file", async () => {
    await setup();
    try {
      const filePath = join(tmpDir, "SKILL.md");
      await writeFile(filePath, VALID_MINIMAL_SKILL, "utf-8");

      const result = await readSkillMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.metadata.name).toBe("daily-planner");
      expect(result.value.metadata.description).toBe("Helps plan the day");
      expect(result.value.body).toContain("# Daily Planner");
    } finally {
      await teardown();
    }
  });

  it("reads and parses a SKILL.md with full metadata", async () => {
    await setup();
    try {
      const filePath = join(tmpDir, "SKILL.md");
      await writeFile(filePath, VALID_FULL_SKILL, "utf-8");

      const result = await readSkillMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.metadata.name).toBe("email-automation");
      expect(result.value.metadata.triggers).toEqual(["help with email", "send email", "inbox triage"]);
      expect(result.value.metadata.config).toEqual({
        envVars: ["GMAIL_API_KEY", "SMTP_HOST"],
        stateDirs: ["~/.reins/state/email"],
      });
    } finally {
      await teardown();
    }
  });

  it("returns error when file does not exist", async () => {
    const result = await readSkillMd("/nonexistent/path/SKILL.md");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error).toBeInstanceOf(SkillError);
    expect(result.error.message).toContain("Failed to read SKILL.md");
    expect(result.error.message).toContain("/nonexistent/path/SKILL.md");
    expect(result.error.code).toBe(SKILL_ERROR_CODES.NOT_FOUND);
  });

  it("returns parse error for invalid file content", async () => {
    await setup();
    try {
      const filePath = join(tmpDir, "SKILL.md");
      await writeFile(filePath, "no frontmatter here", "utf-8");

      const result = await readSkillMd(filePath);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("must start with YAML frontmatter delimiters");
      expect(result.error.code).toBe(SKILL_ERROR_CODES.PARSE);
    } finally {
      await teardown();
    }
  });

  it("returns validation error for file with missing required fields", async () => {
    await setup();
    try {
      const filePath = join(tmpDir, "SKILL.md");
      await writeFile(filePath, "---\nname: valid-name\n---\n\n# Body", "utf-8");

      const result = await readSkillMd(filePath);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("description");
      expect(result.error.code).toBe(SKILL_ERROR_CODES.VALIDATION);
    } finally {
      await teardown();
    }
  });
});
