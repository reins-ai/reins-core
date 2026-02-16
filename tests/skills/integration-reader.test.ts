import { afterAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  readIntegrationMd,
  getIntegrationStatus,
} from "../../src/skills/integration-reader";
import { SkillError } from "../../src/skills/errors";

const tempDirs: string[] = [];

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reins-integration-reader-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
});

const FULL_INTEGRATION_MD = `# Gmail Integration Setup

This guide helps you set up Gmail access for Reins.

## Prerequisites

- A Google Cloud project with Gmail API enabled
- OAuth credentials configured

## Setup

1. Go to the Google Cloud Console
2. Create OAuth 2.0 credentials
3. Download the credentials JSON file

## Configuration

Set the following environment variables:

- \`GMAIL_CLIENT_ID\`: Your OAuth client ID
- \`GMAIL_CLIENT_SECRET\`: Your OAuth client secret

## Verification

Run the following command to verify:

\`\`\`bash
reins integration test gmail
\`\`\`
`;

const NO_SETUP_STEPS_MD = `# Weather Skill Notes

Some general notes about the weather skill.

## Overview

This skill provides weather information.

## Limitations

- Only supports US locations
- Data may be delayed by up to 15 minutes
`;

const NUMBERED_STEPS_ONLY_MD = `# Quick Start

Follow these steps:

1. Install the CLI tool
2. Run the setup command
3. Verify the installation
`;

const SINGLE_SECTION_MD = `# About This Integration

This integration connects Reins to your calendar service.
It requires an API key to function properly.
`;

describe("readIntegrationMd", () => {
  describe("valid files", () => {
    it("parses a full INTEGRATION.md with multiple sections", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, FULL_INTEGRATION_MD);

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.content).toBe(FULL_INTEGRATION_MD);
      expect(result.value.sections).toHaveLength(5);
      expect(result.value.hasSetupSteps).toBe(true);
    });

    it("extracts section titles and levels correctly", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, FULL_INTEGRATION_MD);

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const sections = result.value.sections;
      expect(sections[0].title).toBe("Gmail Integration Setup");
      expect(sections[0].level).toBe(1);

      expect(sections[1].title).toBe("Prerequisites");
      expect(sections[1].level).toBe(2);

      expect(sections[2].title).toBe("Setup");
      expect(sections[2].level).toBe(2);

      expect(sections[3].title).toBe("Configuration");
      expect(sections[3].level).toBe(2);

      expect(sections[4].title).toBe("Verification");
      expect(sections[4].level).toBe(2);
    });

    it("extracts section content without the heading line", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, FULL_INTEGRATION_MD);

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const prereqSection = result.value.sections[1];
      expect(prereqSection.content).toContain("Google Cloud project");
      expect(prereqSection.content).toContain("OAuth credentials");
      expect(prereqSection.content).not.toContain("## Prerequisites");
    });

    it("detects hasSetupSteps when setup-related headings are present", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, FULL_INTEGRATION_MD);

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hasSetupSteps).toBe(true);
    });

    it("detects hasSetupSteps when numbered lists are present without setup headings", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, NUMBERED_STEPS_ONLY_MD);

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hasSetupSteps).toBe(true);
    });

    it("returns hasSetupSteps false when no setup indicators are present", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, NO_SETUP_STEPS_MD);

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.hasSetupSteps).toBe(false);
    });

    it("handles a single section correctly", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, SINGLE_SECTION_MD);

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.sections).toHaveLength(1);
      expect(result.value.sections[0].title).toBe("About This Integration");
      expect(result.value.sections[0].level).toBe(1);
      expect(result.value.sections[0].content).toContain("calendar service");
    });

    it("preserves raw content exactly as read from file", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, FULL_INTEGRATION_MD);

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.content).toBe(FULL_INTEGRATION_MD);
    });
  });

  describe("error cases", () => {
    it("returns error when file does not exist", async () => {
      const result = await readIntegrationMd("/nonexistent/path/INTEGRATION.md");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("Failed to read INTEGRATION.md");
      expect(result.error.message).toContain("/nonexistent/path/INTEGRATION.md");
    });

    it("returns error when file is empty", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, "");

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("empty");
    });

    it("returns error when file contains only whitespace", async () => {
      const dir = await createTempDir();
      const filePath = join(dir, "INTEGRATION.md");
      await writeFile(filePath, "   \n\n  \n  ");

      const result = await readIntegrationMd(filePath);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBeInstanceOf(SkillError);
      expect(result.error.message).toContain("empty");
    });
  });
});

describe("getIntegrationStatus", () => {
  it("returns 'not_required' when skill has no INTEGRATION.md", () => {
    expect(getIntegrationStatus(false)).toBe("not_required");
  });

  it("returns 'not_required' regardless of setupComplete when no INTEGRATION.md", () => {
    expect(getIntegrationStatus(false, true)).toBe("not_required");
  });

  it("returns 'needs_setup' when skill has INTEGRATION.md but setup is not complete", () => {
    expect(getIntegrationStatus(true)).toBe("needs_setup");
  });

  it("returns 'needs_setup' when setupComplete is explicitly false", () => {
    expect(getIntegrationStatus(true, false)).toBe("needs_setup");
  });

  it("returns 'setup_complete' when skill has INTEGRATION.md and setup is done", () => {
    expect(getIntegrationStatus(true, true)).toBe("setup_complete");
  });
});
