/**
 * Tests for MEMORY.md integration into the environment system context.
 *
 * Verifies that MEMORY.md content is loaded from the active environment
 * directory and included in the system prompt built by SystemPromptBuilder,
 * with graceful omission when the file does not exist.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileEnvironmentResolver } from "../../src/environment/file-resolver";
import { ENVIRONMENT_DOCUMENTS, OPTIONAL_ENVIRONMENT_DOCUMENTS } from "../../src/environment/types";
import { SystemPromptBuilder } from "../../src/persona/builder";
import type { EnvironmentDocumentMap } from "../../src/environment/types";

const REQUIRED_DOCS = [
  "PERSONALITY",
  "USER",
  "HEARTBEAT",
  "ROUTINES",
  "GOALS",
  "KNOWLEDGE",
  "TOOLS",
  "BOUNDARIES",
] as const;

const DOCUMENT_FILENAMES: Record<string, string> = {
  PERSONALITY: "PERSONALITY.md",
  USER: "USER.md",
  HEARTBEAT: "HEARTBEAT.md",
  ROUTINES: "ROUTINES.md",
  GOALS: "GOALS.md",
  KNOWLEDGE: "KNOWLEDGE.md",
  TOOLS: "TOOLS.md",
  BOUNDARIES: "BOUNDARIES.md",
  MEMORY: "MEMORY.md",
  PERSONA: "PERSONA.yaml",
};

const createdDirectories: string[] = [];

async function createTempEnvironmentsRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-env-svc-"));
  createdDirectories.push(directory);
  return directory;
}

async function setupEnvironment(
  environmentsRoot: string,
  envName: string,
  documents: Partial<Record<string, string>>,
): Promise<void> {
  const envDir = join(environmentsRoot, envName);
  await mkdir(envDir, { recursive: true });

  for (const [docType, content] of Object.entries(documents)) {
    const filename = DOCUMENT_FILENAMES[docType];
    if (filename && content !== undefined) {
      await writeFile(join(envDir, filename), content, "utf8");
    }
  }
}

function createAllRequiredDocs(prefix = "Default"): Record<string, string> {
  const docs: Record<string, string> = {};
  for (const docType of REQUIRED_DOCS) {
    docs[docType] = `${prefix} ${docType} content`;
  }
  return docs;
}

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (!directory) continue;
    await rm(directory, { recursive: true, force: true });
  }
});

describe("MEMORY.md in environment types", () => {
  it("includes MEMORY in ENVIRONMENT_DOCUMENTS", () => {
    expect(ENVIRONMENT_DOCUMENTS).toContain("MEMORY");
  });

  it("marks MEMORY as an optional document", () => {
    expect(OPTIONAL_ENVIRONMENT_DOCUMENTS.has("MEMORY")).toBe(true);
  });

  it("marks PERSONA as an optional document", () => {
    expect(OPTIONAL_ENVIRONMENT_DOCUMENTS.has("PERSONA")).toBe(true);
  });

  it("does not mark required documents as optional", () => {
    for (const docType of REQUIRED_DOCS) {
      expect(OPTIONAL_ENVIRONMENT_DOCUMENTS.has(docType)).toBe(false);
    }
  });
});

describe("MEMORY.md in FileEnvironmentResolver", () => {
  it("resolves MEMORY.md when present in active environment", async () => {
    const root = await createTempEnvironmentsRoot();
    const memoryContent = "# Memory Summary\n\n## Facts\n### User likes TypeScript";
    await setupEnvironment(root, "default", {
      ...createAllRequiredDocs(),
      MEMORY: memoryContent,
    });

    const resolver = new FileEnvironmentResolver(root);
    const result = await resolver.resolveDocument("MEMORY", "default");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.document.content).toBe(memoryContent);
    expect(result.value.type).toBe("MEMORY");
  });

  it("resolveAll succeeds when MEMORY.md is missing", async () => {
    const root = await createTempEnvironmentsRoot();
    await setupEnvironment(root, "default", createAllRequiredDocs());

    const resolver = new FileEnvironmentResolver(root);
    const result = await resolver.resolveAll("default");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.documents.MEMORY).toBeUndefined();
  });

  it("resolveAll includes MEMORY.md when present", async () => {
    const root = await createTempEnvironmentsRoot();
    const memoryContent = "# Memory Summary\n\n## Preferences\n### Dark mode preferred";
    await setupEnvironment(root, "default", {
      ...createAllRequiredDocs(),
      MEMORY: memoryContent,
    });

    const resolver = new FileEnvironmentResolver(root);
    const result = await resolver.resolveAll("default");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.documents.MEMORY).toBeDefined();
    expect(result.value.documents.MEMORY.document.content).toBe(memoryContent);
  });

  it("resolveAll still errors when a required document is missing", async () => {
    const root = await createTempEnvironmentsRoot();
    // Only provide PERSONALITY — other required docs are missing
    await setupEnvironment(root, "default", { PERSONALITY: "Default persona" });

    const resolver = new FileEnvironmentResolver(root);
    const result = await resolver.resolveAll("default");

    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.code).toBe("DOCUMENT_NOT_FOUND");
  });

  it("resolves MEMORY.md from active environment over default", async () => {
    const root = await createTempEnvironmentsRoot();
    await setupEnvironment(root, "default", {
      ...createAllRequiredDocs(),
      MEMORY: "Default memories",
    });
    await setupEnvironment(root, "work", {
      MEMORY: "Work memories",
    });

    const resolver = new FileEnvironmentResolver(root);
    const result = await resolver.resolveAll("work");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.documents.MEMORY.document.content).toBe("Work memories");
    expect(result.value.documents.MEMORY.source).toBe("active");
    expect(result.value.documents.MEMORY.sourceEnvironment).toBe("work");
  });

  it("falls back to default MEMORY.md when active environment lacks it", async () => {
    const root = await createTempEnvironmentsRoot();
    await setupEnvironment(root, "default", {
      ...createAllRequiredDocs(),
      MEMORY: "Default memories",
    });
    await setupEnvironment(root, "work", {});

    const resolver = new FileEnvironmentResolver(root);
    const result = await resolver.resolveAll("work");

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.documents.MEMORY.document.content).toBe("Default memories");
    expect(result.value.documents.MEMORY.source).toBe("default");
  });
});

describe("MEMORY.md in SystemPromptBuilder", () => {
  it("includes MEMORY.md content in system prompt as Current Memories section", () => {
    const builder = new SystemPromptBuilder();
    const persona = {
      id: "test",
      name: "Test",
      description: "Test persona",
      systemPrompt: "You are a helpful assistant.",
      toolPermissions: { mode: "all" as const },
    };

    const memoryContent = [
      "# Memory Summary",
      "",
      "## Facts",
      "### User prefers TypeScript",
      "- Importance: high",
      "- Tags: programming, preference",
    ].join("\n");

    const environmentDocuments: EnvironmentDocumentMap = {
      PERSONALITY: "You are a professional assistant.",
      MEMORY: memoryContent,
    };

    const prompt = builder.build({ persona, environmentDocuments });

    expect(prompt).toContain("## Current Memories");
    expect(prompt).toContain("User prefers TypeScript");
    expect(prompt).toContain("Importance: high");
  });

  it("omits Current Memories section when MEMORY.md is not present", () => {
    const builder = new SystemPromptBuilder();
    const persona = {
      id: "test",
      name: "Test",
      description: "Test persona",
      systemPrompt: "You are a helpful assistant.",
      toolPermissions: { mode: "all" as const },
    };

    const environmentDocuments: EnvironmentDocumentMap = {
      PERSONALITY: "You are a professional assistant.",
    };

    const prompt = builder.build({ persona, environmentDocuments });

    expect(prompt).not.toContain("## Current Memories");
    expect(prompt).not.toContain("MEMORY");
  });

  it("omits Current Memories section when MEMORY.md content is empty", () => {
    const builder = new SystemPromptBuilder();
    const persona = {
      id: "test",
      name: "Test",
      description: "Test persona",
      systemPrompt: "You are a helpful assistant.",
      toolPermissions: { mode: "all" as const },
    };

    const environmentDocuments: EnvironmentDocumentMap = {
      PERSONALITY: "You are a professional assistant.",
      MEMORY: "",
    };

    const prompt = builder.build({ persona, environmentDocuments });

    expect(prompt).not.toContain("## Current Memories");
  });

  it("omits Current Memories section when MEMORY.md content is whitespace only", () => {
    const builder = new SystemPromptBuilder();
    const persona = {
      id: "test",
      name: "Test",
      description: "Test persona",
      systemPrompt: "You are a helpful assistant.",
      toolPermissions: { mode: "all" as const },
    };

    const environmentDocuments: EnvironmentDocumentMap = {
      PERSONALITY: "You are a professional assistant.",
      MEMORY: "   \n  \n  ",
    };

    const prompt = builder.build({ persona, environmentDocuments });

    expect(prompt).not.toContain("## Current Memories");
  });

  it("places Current Memories section after skills and before Dynamic Context", () => {
    const builder = new SystemPromptBuilder();
    const persona = {
      id: "test",
      name: "Test",
      description: "Test persona",
      systemPrompt: "You are a helpful assistant.",
      toolPermissions: { mode: "all" as const },
    };

    const environmentDocuments: EnvironmentDocumentMap = {
      PERSONALITY: "You are a professional assistant.",
      MEMORY: "# Memory Summary\n\n## Facts\n### User likes dark mode",
      HEARTBEAT: "Active heartbeat",
      ROUTINES: "Morning routine",
    };

    const prompt = builder.build({ persona, environmentDocuments });

    const memoryIndex = prompt.indexOf("## Current Memories");
    const dynamicIndex = prompt.indexOf("## Dynamic Context");

    expect(memoryIndex).toBeGreaterThan(0);
    expect(dynamicIndex).toBeGreaterThan(memoryIndex);
  });
});

describe("MEMORY.md content freshness", () => {
  it("reflects latest file content on each resolveDocument call", async () => {
    const root = await createTempEnvironmentsRoot();
    const envDir = join(root, "default");
    await setupEnvironment(root, "default", {
      ...createAllRequiredDocs(),
      MEMORY: "Version 1",
    });

    const resolver = new FileEnvironmentResolver(root);

    const result1 = await resolver.resolveDocument("MEMORY", "default");
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    expect(result1.value.document.content).toBe("Version 1");

    // Update the file
    await writeFile(join(envDir, "MEMORY.md"), "Version 2", "utf8");

    const result2 = await resolver.resolveDocument("MEMORY", "default");
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.document.content).toBe("Version 2");
  });

  it("reflects latest file content on each resolveAll call", async () => {
    const root = await createTempEnvironmentsRoot();
    const envDir = join(root, "default");
    await setupEnvironment(root, "default", {
      ...createAllRequiredDocs(),
      MEMORY: "Initial memories",
    });

    const resolver = new FileEnvironmentResolver(root);

    const result1 = await resolver.resolveAll("default");
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    expect(result1.value.documents.MEMORY.document.content).toBe("Initial memories");

    // Update the file to simulate MemorySummaryGenerator regeneration
    await writeFile(join(envDir, "MEMORY.md"), "Updated memories", "utf8");

    const result2 = await resolver.resolveAll("default");
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    expect(result2.value.documents.MEMORY.document.content).toBe("Updated memories");
  });
});
