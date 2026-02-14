import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SystemPromptBuilder } from "../../src/persona/builder";
import { EnvironmentContextProvider } from "../../src/persona/environment-context";
import { truncateSection, TRUNCATION_MARKER } from "../../src/persona/truncate";
import { DEFAULT_SECTION_BUDGETS } from "../../src/persona/prompt-budgets";
import { FileEnvironmentResolver } from "../../src/environment/file-resolver";
import { ENVIRONMENT_DOCUMENTS, type EnvironmentDocument, type EnvironmentDocumentMap } from "../../src/environment/types";
import type { Persona } from "../../src/persona/persona";
import { ok } from "../../src/result";
import type { OverlayResolution } from "../../src/environment/types";

const createdDirectories: string[] = [];

async function createTempDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  createdDirectories.push(directory);
  return directory;
}

async function setupEnvironment(
  environmentsRoot: string,
  environmentName: string,
  documents: Partial<Record<EnvironmentDocument, string>>,
): Promise<void> {
  const environmentDirectory = join(environmentsRoot, environmentName);
  await mkdir(environmentDirectory, { recursive: true });

  for (const documentType of ENVIRONMENT_DOCUMENTS) {
    const content = documents[documentType];
    if (typeof content === "undefined") {
      continue;
    }

    await writeFile(
      join(environmentDirectory, `${documentType}.md`),
      content,
      "utf8",
    );
  }
}

function buildFullDocumentSet(prefix: string): Record<EnvironmentDocument, string> {
  const set = {} as Record<EnvironmentDocument, string>;

  for (const documentType of ENVIRONMENT_DOCUMENTS) {
    set[documentType] = `${prefix} ${documentType} content`;
  }

  return set;
}

function createTestPersona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: "test-persona",
    name: "Test Persona",
    description: "Test description",
    systemPrompt: "You are a helpful test assistant.",
    toolPermissions: { mode: "all" },
    ...overrides,
  };
}

function createOverlayResolution(
  documents: Partial<Record<EnvironmentDocument, string>>,
  environmentName = "default",
): OverlayResolution {
  const now = new Date();
  const fullDocuments = {} as Record<EnvironmentDocument, {
    type: EnvironmentDocument;
    source: "active" | "default";
    sourceEnvironment: string;
    document: {
      type: EnvironmentDocument;
      path: string;
      content: string;
      environmentName: string;
      loadedAt: Date;
    };
  }>;

  for (const docType of ENVIRONMENT_DOCUMENTS) {
    const content = documents[docType] ?? "";
    fullDocuments[docType] = {
      type: docType,
      source: "active",
      sourceEnvironment: environmentName,
      document: {
        type: docType,
        path: `${environmentName}/${docType}.md`,
        content,
        environmentName,
        loadedAt: now,
      },
    };
  }

  return {
    activeEnvironment: environmentName,
    fallbackEnvironment: "default",
    documents: fullDocuments,
  };
}

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (!directory) {
      continue;
    }

    await rm(directory, { recursive: true, force: true });
  }
});

describe("Environment prompt assembly", () => {
  describe("default environment prompt", () => {
    it("produces prompt with default templates", async () => {
      const root = await createTempDirectory("reins-env-prompt-default-");
      const environmentsRoot = join(root, "environments");

      await setupEnvironment(environmentsRoot, "default", {
        PERSONALITY: "You are a professional personal assistant.",
        BOUNDARIES: "Do not provide medical advice.",
        USER: "Name: Alex\nTimezone: UTC",
        HEARTBEAT: "Check reminders every 30 minutes.",
        ROUTINES: "Morning briefing at 8am.",
        GOALS: "Stay productive.",
        KNOWLEDGE: "Favorite color: blue.",
        TOOLS: "Calendar: enabled.",
      });

      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const resolveResult = await resolver.resolveAll("default");
      expect(resolveResult.ok).toBe(true);
      if (!resolveResult.ok) return;

      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();

      const environmentDocuments: EnvironmentDocumentMap = {};
      for (const [docType, resolution] of Object.entries(resolveResult.value.documents)) {
        environmentDocuments[docType as EnvironmentDocument] = resolution.document.content;
      }

      const prompt = builder.build({ persona, environmentDocuments });

      expect(prompt).toContain("## Identity");
      expect(prompt).toContain("You are a professional personal assistant.");
      expect(prompt).toContain("## Boundaries");
      expect(prompt).toContain("Do not provide medical advice.");
      expect(prompt).toContain("## User Context");
      expect(prompt).toContain("Name: Alex");
    });

    it("produces different prompt when work environment has custom PERSONALITY.md", async () => {
      const root = await createTempDirectory("reins-env-prompt-diff-");
      const environmentsRoot = join(root, "environments");

      await setupEnvironment(environmentsRoot, "default", buildFullDocumentSet("Default"));
      await setupEnvironment(environmentsRoot, "work", {
        PERSONALITY: "You are a focused work assistant. No small talk.",
      });

      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();

      const defaultResult = await resolver.resolveAll("default");
      expect(defaultResult.ok).toBe(true);
      if (!defaultResult.ok) return;

      const defaultDocs: EnvironmentDocumentMap = {};
      for (const [docType, resolution] of Object.entries(defaultResult.value.documents)) {
        defaultDocs[docType as EnvironmentDocument] = resolution.document.content;
      }

      const workResult = await resolver.resolveAll("work");
      expect(workResult.ok).toBe(true);
      if (!workResult.ok) return;

      const workDocs: EnvironmentDocumentMap = {};
      for (const [docType, resolution] of Object.entries(workResult.value.documents)) {
        workDocs[docType as EnvironmentDocument] = resolution.document.content;
      }

      const defaultPrompt = builder.build({ persona, environmentDocuments: defaultDocs });
      const workPrompt = builder.build({ persona, environmentDocuments: workDocs });

      expect(defaultPrompt).not.toBe(workPrompt);
      expect(defaultPrompt).toContain("Default PERSONALITY content");
      expect(workPrompt).toContain("You are a focused work assistant. No small talk.");
      expect(workPrompt).not.toContain("Default PERSONALITY content");
    });
  });

  describe("document section placement", () => {
    it("places PERSONALITY.md content in the identity section", () => {
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();
      const environmentDocuments: EnvironmentDocumentMap = {
        PERSONALITY: "I am a creative writing assistant with a warm tone.",
      };

      const prompt = builder.build({ persona, environmentDocuments });

      expect(prompt).toContain("## Identity");
      expect(prompt).toContain("I am a creative writing assistant with a warm tone.");

      const identityIndex = prompt.indexOf("## Identity");
      const contentIndex = prompt.indexOf("I am a creative writing assistant with a warm tone.");
      expect(contentIndex).toBeGreaterThan(identityIndex);
    });

    it("places USER.md content in the user context section", () => {
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();
      const environmentDocuments: EnvironmentDocumentMap = {
        PERSONALITY: "Base identity.",
        USER: "Name: Jordan\nPreferences: concise answers, no emojis",
      };

      const prompt = builder.build({ persona, environmentDocuments });

      expect(prompt).toContain("## User Context");
      expect(prompt).toContain("Name: Jordan");
      expect(prompt).toContain("Preferences: concise answers, no emojis");
    });

    it("places BOUNDARIES.md content in the boundaries section", () => {
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();
      const environmentDocuments: EnvironmentDocumentMap = {
        PERSONALITY: "Base identity.",
        BOUNDARIES: "Will not: provide financial advice\nWill: help with scheduling",
      };

      const prompt = builder.build({ persona, environmentDocuments });

      expect(prompt).toContain("## Boundaries");
      expect(prompt).toContain("Will not: provide financial advice");
      expect(prompt).toContain("Will: help with scheduling");
    });
  });

  describe("stable section ordering", () => {
    it("orders identity before boundaries before user before tools", () => {
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();
      const environmentDocuments: EnvironmentDocumentMap = {
        PERSONALITY: "Identity content.",
        BOUNDARIES: "Boundaries content.",
        USER: "User content.",
        HEARTBEAT: "Heartbeat content.",
        TOOLS: "Tools content.",
      };

      const prompt = builder.build({
        persona,
        environmentDocuments,
        currentDate: new Date("2026-02-13T10:00:00.000Z"),
        additionalInstructions: ["Be concise"],
      });

      const identityIndex = prompt.indexOf("## Identity");
      const boundariesIndex = prompt.indexOf("## Boundaries");
      const userIndex = prompt.indexOf("## User Context");
      const dateIndex = prompt.indexOf("## Current Date and Time");
      const dynamicIndex = prompt.indexOf("## Dynamic Context");
      const instructionsIndex = prompt.indexOf("## Additional Instructions");

      expect(identityIndex).toBeGreaterThanOrEqual(0);
      expect(boundariesIndex).toBeGreaterThan(identityIndex);
      expect(userIndex).toBeGreaterThan(boundariesIndex);
      expect(dateIndex).toBeGreaterThan(userIndex);
      expect(dynamicIndex).toBeGreaterThan(dateIndex);
      expect(instructionsIndex).toBeGreaterThan(dynamicIndex);
    });

    it("maintains stable ordering across repeated builds", () => {
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();
      const environmentDocuments: EnvironmentDocumentMap = {
        PERSONALITY: "Stable identity.",
        BOUNDARIES: "Stable boundaries.",
        USER: "Stable user.",
      };

      const prompt1 = builder.build({ persona, environmentDocuments });
      const prompt2 = builder.build({ persona, environmentDocuments });
      const prompt3 = builder.build({ persona, environmentDocuments });

      expect(prompt1).toBe(prompt2);
      expect(prompt2).toBe(prompt3);
    });

    it("identity section always appears first even with minimal documents", () => {
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();
      const environmentDocuments: EnvironmentDocumentMap = {
        PERSONALITY: "Minimal identity.",
      };

      const prompt = builder.build({ persona, environmentDocuments });

      expect(prompt.startsWith("## Identity")).toBe(true);
    });
  });

  describe("budget truncation", () => {
    it("truncates oversized USER.md content with truncation marker", () => {
      const userBudget = DEFAULT_SECTION_BUDGETS.USER.maxChars;
      const oversizedContent = "User preference line.\n".repeat(200);
      expect(oversizedContent.length).toBeGreaterThan(userBudget);

      const truncated = truncateSection(oversizedContent, userBudget);

      expect(truncated.length).toBeLessThanOrEqual(userBudget);
      expect(truncated).toContain(TRUNCATION_MARKER.trim());
    });

    it("does not truncate USER.md content within budget", () => {
      const shortContent = "Name: Alex\nTimezone: UTC";
      expect(shortContent.length).toBeLessThan(DEFAULT_SECTION_BUDGETS.USER.maxChars);

      const result = truncateSection(shortContent, DEFAULT_SECTION_BUDGETS.USER.maxChars);

      expect(result).toBe(shortContent);
      expect(result).not.toContain(TRUNCATION_MARKER.trim());
    });

    it("truncates oversized PERSONALITY.md content with truncation marker", () => {
      const personalityBudget = DEFAULT_SECTION_BUDGETS.PERSONALITY.maxChars;
      const oversizedContent = "Personality trait description paragraph.\n\n".repeat(100);
      expect(oversizedContent.length).toBeGreaterThan(personalityBudget);

      const truncated = truncateSection(oversizedContent, personalityBudget);

      expect(truncated.length).toBeLessThanOrEqual(personalityBudget);
      expect(truncated).toContain(TRUNCATION_MARKER.trim());
    });

    it("truncated content appears correctly in assembled prompt", () => {
      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();
      const oversizedUser = "User detail line.\n".repeat(200);
      const truncatedUser = truncateSection(oversizedUser, DEFAULT_SECTION_BUDGETS.USER.maxChars);

      const environmentDocuments: EnvironmentDocumentMap = {
        PERSONALITY: "Identity.",
        USER: truncatedUser,
      };

      const prompt = builder.build({ persona, environmentDocuments });

      expect(prompt).toContain("## User Context");
      expect(prompt).toContain(TRUNCATION_MARKER.trim());
    });
  });

  describe("EnvironmentContextProvider integration", () => {
    it("builds prompt from resolved environment documents via provider", async () => {
      const resolver = {
        getResolvedDocuments: async () =>
          ok(
            createOverlayResolution({
              PERSONALITY: "Provider-resolved identity.",
              USER: "Provider-resolved user context.",
              BOUNDARIES: "Provider-resolved boundaries.",
            }),
          ),
      };

      const provider = new EnvironmentContextProvider(resolver, new SystemPromptBuilder());
      const persona = createTestPersona();
      const result = await provider.buildEnvironmentPrompt(persona);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toContain("## Identity");
      expect(result.value).toContain("Provider-resolved identity.");
      expect(result.value).toContain("## User Context");
      expect(result.value).toContain("Provider-resolved user context.");
      expect(result.value).toContain("## Boundaries");
      expect(result.value).toContain("Provider-resolved boundaries.");
    });

    it("uses PERSONALITY from environment instead of persona systemPrompt", async () => {
      const resolver = {
        getResolvedDocuments: async () =>
          ok(
            createOverlayResolution({
              PERSONALITY: "Custom environment personality.",
            }),
          ),
      };

      const provider = new EnvironmentContextProvider(resolver, new SystemPromptBuilder());
      const persona = createTestPersona({ systemPrompt: "This should be overridden." });
      const result = await provider.buildEnvironmentPrompt(persona);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toContain("Custom environment personality.");
      expect(result.value).not.toContain("This should be overridden.");
    });

    it("falls back to persona systemPrompt when PERSONALITY is empty", async () => {
      const resolver = {
        getResolvedDocuments: async () =>
          ok(
            createOverlayResolution({
              PERSONALITY: "",
            }),
          ),
      };

      const provider = new EnvironmentContextProvider(resolver, new SystemPromptBuilder());
      const persona = createTestPersona({ systemPrompt: "Fallback persona prompt." });
      const result = await provider.buildEnvironmentPrompt(persona);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toContain("Fallback persona prompt.");
    });
  });

  describe("filesystem-backed prompt assembly", () => {
    it("assembles prompt from real environment files on disk", async () => {
      const root = await createTempDirectory("reins-env-prompt-fs-");
      const environmentsRoot = join(root, "environments");

      await setupEnvironment(environmentsRoot, "default", {
        PERSONALITY: "# Default Assistant\nYou are helpful and friendly.",
        BOUNDARIES: "# Boundaries\n- No medical advice\n- No legal advice",
        USER: "# User Profile\nName: Sam\nLocation: NYC",
        HEARTBEAT: "Check every 30 minutes.",
        ROUTINES: "Morning briefing at 8am.",
        GOALS: "Stay organized.",
        KNOWLEDGE: "Favorite food: pizza.",
        TOOLS: "Calendar: enabled.",
      });

      const resolver = new FileEnvironmentResolver(environmentsRoot);
      const resolveResult = await resolver.resolveAll("default");
      expect(resolveResult.ok).toBe(true);
      if (!resolveResult.ok) return;

      const builder = new SystemPromptBuilder();
      const persona = createTestPersona();

      const environmentDocuments: EnvironmentDocumentMap = {};
      for (const [docType, resolution] of Object.entries(resolveResult.value.documents)) {
        environmentDocuments[docType as EnvironmentDocument] = resolution.document.content;
      }

      const prompt = builder.build({ persona, environmentDocuments });

      expect(prompt).toContain("# Default Assistant");
      expect(prompt).toContain("You are helpful and friendly.");
      expect(prompt).toContain("No medical advice");
      expect(prompt).toContain("Name: Sam");
      expect(prompt).toContain("## Dynamic Context");
      expect(prompt).toContain("Heartbeat context loaded from HEARTBEAT.md");
      expect(prompt).toContain("Routine context loaded from ROUTINES.md");
      expect(prompt).toContain("Goals context loaded from GOALS.md");
      expect(prompt).toContain("Knowledge context available from KNOWLEDGE.md");
      expect(prompt).toContain("Tool preferences available from TOOLS.md");
    });
  });
});
