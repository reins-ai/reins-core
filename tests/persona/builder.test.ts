import { describe, expect, it } from "bun:test";

import { SystemPromptBuilder } from "../../src/persona/builder";
import type { EnvironmentDocumentMap } from "../../src/environment/types";
import type { Persona } from "../../src/persona/persona";
import type { SkillSummary } from "../../src/skills/types";
import type { ToolDefinition } from "../../src/types";

const createPersona = (toolMode: Persona["toolPermissions"]["mode"], tools?: string[]): Persona => ({
  id: "test-persona",
  name: "Test Persona",
  description: "Test description",
  systemPrompt: "Base persona prompt.",
  toolPermissions: {
    mode: toolMode,
    tools,
  },
});

const createTool = (name: string, description: string): ToolDefinition => ({
  name,
  description,
  parameters: {
    type: "object",
    properties: {},
  },
});

describe("SystemPromptBuilder", () => {
  it("builds with just persona prompt", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");

    const prompt = builder.build({ persona });

    expect(prompt).toBe("Base persona prompt.");
  });

  it("includes date context", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");
    const now = new Date("2026-02-10T12:34:56.000Z");

    const prompt = builder.build({ persona, currentDate: now });

    expect(prompt).toContain("## Current Date and Time");
    expect(prompt).toContain("2026-02-10T12:34:56.000Z");
  });

  it("includes user context", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");

    const prompt = builder.build({ persona, userContext: "User: Alex, Timezone: UTC" });

    expect(prompt).toContain("## User Context");
    expect(prompt).toContain("User: Alex, Timezone: UTC");
  });

  it("includes available tools", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");
    const tools = [createTool("calendar.create", "Create a calendar event")];

    const prompt = builder.build({ persona, availableTools: tools });

    expect(prompt).toContain("## Available Tools");
    expect(prompt).toContain("- calendar.create: Create a calendar event");
  });

  it("filters tools for allowlist permissions", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("allowlist", ["notes.create"]);
    const tools = [
      createTool("notes.create", "Create a note"),
      createTool("calendar.create", "Create a calendar event"),
    ];

    const prompt = builder.build({ persona, availableTools: tools });

    expect(prompt).toContain("- notes.create: Create a note");
    expect(prompt).not.toContain("calendar.create");
  });

  it("filters tools for blocklist permissions", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("blocklist", ["calendar.create"]);
    const tools = [
      createTool("notes.create", "Create a note"),
      createTool("calendar.create", "Create a calendar event"),
    ];

    const prompt = builder.build({ persona, availableTools: tools });

    expect(prompt).toContain("- notes.create: Create a note");
    expect(prompt).not.toContain("calendar.create");
  });

  it("includes all tools when all tools are permitted", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");
    const tools = [
      createTool("notes.create", "Create a note"),
      createTool("calendar.create", "Create a calendar event"),
    ];

    const prompt = builder.build({ persona, availableTools: tools });

    expect(prompt).toContain("- notes.create: Create a note");
    expect(prompt).toContain("- calendar.create: Create a calendar event");
  });

  it("includes additional instructions", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");

    const prompt = builder.build({
      persona,
      additionalInstructions: ["Prioritize urgent items", "Confirm before deleting reminders"],
    });

    expect(prompt).toContain("## Additional Instructions");
    expect(prompt).toContain("- Prioritize urgent items");
    expect(prompt).toContain("- Confirm before deleting reminders");
  });

  it("includes skill index when skill summaries are provided", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");
    const skillSummaries: SkillSummary[] = [
      { name: "code-review", description: "Reviews code for correctness and quality" },
    ];

    const prompt = builder.build({ persona, skillSummaries });

    expect(prompt).toContain("## Available Skills");
    expect(prompt).toContain("- **code-review**: Reviews code for correctness and quality");
  });

  it("omits skill index when skill summaries are empty", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");

    const prompt = builder.build({ persona, skillSummaries: [] });

    expect(prompt).not.toContain("## Available Skills");
  });

  it("combines all sections in the expected order", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");
    const tools = [createTool("notes.create", "Create a note")];
    const now = new Date("2026-02-10T12:34:56.000Z");

    const prompt = builder.build({
      persona,
      currentDate: now,
      userContext: "User: Alex",
      availableTools: tools,
      additionalInstructions: ["Keep answers short"],
    });

    const baseIndex = prompt.indexOf("Base persona prompt.");
    const dateIndex = prompt.indexOf("## Current Date and Time");
    const userIndex = prompt.indexOf("## User Context");
    const toolsIndex = prompt.indexOf("## Available Tools");
    const instructionsIndex = prompt.indexOf("## Additional Instructions");

    expect(baseIndex).toBeGreaterThanOrEqual(0);
    expect(dateIndex).toBeGreaterThan(baseIndex);
    expect(userIndex).toBeGreaterThan(dateIndex);
    expect(toolsIndex).toBeGreaterThan(userIndex);
    expect(instructionsIndex).toBeGreaterThan(toolsIndex);
  });

  it("injects environment documents into identity, boundaries, and user sections", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");
    const environmentDocuments: EnvironmentDocumentMap = {
      PERSONALITY: "You are a professional assistant.",
      BOUNDARIES: "Do not provide medical or legal advice.",
      USER: "The user is Alex and prefers concise responses.",
    };

    const prompt = builder.build({ persona, environmentDocuments });

    expect(prompt).toContain("## Identity");
    expect(prompt).toContain("You are a professional assistant.");
    expect(prompt).toContain("## Boundaries");
    expect(prompt).toContain("Do not provide medical or legal advice.");
    expect(prompt).toContain("## User Context");
    expect(prompt).toContain("The user is Alex and prefers concise responses.");
  });

  it("uses stable section ordering when environment documents are provided", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");
    const tools = [createTool("notes.create", "Create a note")];
    const environmentDocuments: EnvironmentDocumentMap = {
      PERSONALITY: "Environment identity.",
      BOUNDARIES: "Environment boundaries.",
      USER: "Environment user context.",
      HEARTBEAT: "Heartbeat placeholder.",
      TOOLS: "Tool preferences placeholder.",
    };

    const prompt = builder.build({
      persona,
      currentDate: new Date("2026-02-10T12:34:56.000Z"),
      availableTools: tools,
      additionalInstructions: ["Keep answers short"],
      environmentDocuments,
    });

    const identityIndex = prompt.indexOf("## Identity");
    const boundariesIndex = prompt.indexOf("## Boundaries");
    const userIndex = prompt.indexOf("## User Context");
    const dateIndex = prompt.indexOf("## Current Date and Time");
    const toolsIndex = prompt.indexOf("## Available Tools");
    const dynamicIndex = prompt.indexOf("## Dynamic Context");
    const instructionsIndex = prompt.indexOf("## Additional Instructions");

    expect(identityIndex).toBeGreaterThanOrEqual(0);
    expect(boundariesIndex).toBeGreaterThan(identityIndex);
    expect(userIndex).toBeGreaterThan(boundariesIndex);
    expect(dateIndex).toBeGreaterThan(userIndex);
    expect(toolsIndex).toBeGreaterThan(dateIndex);
    expect(dynamicIndex).toBeGreaterThan(toolsIndex);
    expect(instructionsIndex).toBeGreaterThan(dynamicIndex);
  });

  it("adds tool preference and boundary enforcement hints to dynamic context", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");

    const prompt = builder.build({
      persona,
      environmentDocuments: {
        PERSONALITY: "Environment identity.",
        BOUNDARIES: [
          "## Will Not Do",
          "- financial transactions",
        ].join("\n"),
        TOOLS: [
          "## Global Aggressiveness",
          "**Default Mode:** moderate",
          "",
          "### Reminders",
          "**Status:** enabled",
          "**Aggressiveness:** proactive",
          "",
          "### Email",
          "**Status:** disabled",
        ].join("\n"),
      },
    });

    expect(prompt).toContain("## Dynamic Context");
    expect(prompt).toContain("Enabled tools policy: reminders");
    expect(prompt).toContain("Disabled tools policy: email");
    expect(prompt).toContain("Default tool aggressiveness: medium");
    expect(prompt).toContain("Tool aggressiveness hints: reminders=high");
    expect(prompt).toContain("Decline requests matching explicit will-not-do boundaries (1 loaded)");
  });

  it("keeps legacy output unchanged when environment documents are not provided", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");
    const tools = [createTool("notes.create", "Create a note")];

    const prompt = builder.build({
      persona,
      currentDate: new Date("2026-02-10T12:34:56.000Z"),
      userContext: "User: Alex",
      availableTools: tools,
      additionalInstructions: ["Keep answers short"],
    });

    expect(prompt).toBe(
      [
        "Base persona prompt.",
        "## Current Date and Time\n2026-02-10T12:34:56.000Z",
        "## User Context\nUser: Alex",
        "## Available Tools\n- notes.create: Create a note",
        "## Additional Instructions\n- Keep answers short",
      ].join("\n\n"),
    );
  });

  it("uses PERSONALITY environment document instead of base persona prompt", () => {
    const builder = new SystemPromptBuilder();
    const persona = createPersona("all");

    const prompt = builder.build({
      persona,
      environmentDocuments: {
        PERSONALITY: "You are the configured environment persona.",
      },
    });

    expect(prompt).toContain("## Identity");
    expect(prompt).toContain("You are the configured environment persona.");
    expect(prompt).not.toContain("Base persona prompt.");
  });
});
