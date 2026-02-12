import { describe, expect, it } from "bun:test";

import { SystemPromptBuilder } from "../../src/persona/builder";
import type { Persona } from "../../src/persona/persona";
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
});
