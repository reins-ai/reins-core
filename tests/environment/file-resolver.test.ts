import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FileEnvironmentResolver } from "../../src/environment/file-resolver";
import { ENVIRONMENT_DOCUMENTS } from "../../src/environment/types";

const createdDirectories: string[] = [];

async function createTempEnvironmentsRoot(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "reins-resolver-"));
  createdDirectories.push(directory);
  return directory;
}

/**
 * Create a directory structure with environment folders and document files.
 *
 * Example:
 * ```
 * setupEnvironment(root, "default", {
 *   PERSONALITY: "You are helpful.",
 *   USER: "Name: Alice",
 * });
 * ```
 */
async function setupEnvironment(
  environmentsRoot: string,
  envName: string,
  documents: Partial<Record<string, string>>,
): Promise<void> {
  const envDir = join(environmentsRoot, envName);
  await mkdir(envDir, { recursive: true });

  const filenameMap: Record<string, string> = {
    PERSONALITY: "PERSONALITY.md",
    USER: "USER.md",
    HEARTBEAT: "HEARTBEAT.md",
    ROUTINES: "ROUTINES.md",
    GOALS: "GOALS.md",
    KNOWLEDGE: "KNOWLEDGE.md",
    TOOLS: "TOOLS.md",
    BOUNDARIES: "BOUNDARIES.md",
    MEMORY: "MEMORY.md",
  };

  for (const [docType, content] of Object.entries(documents)) {
    const filename = filenameMap[docType];
    if (filename && content !== undefined) {
      await writeFile(join(envDir, filename), content, "utf8");
    }
  }
}

afterEach(async () => {
  while (createdDirectories.length > 0) {
    const directory = createdDirectories.pop();
    if (!directory) continue;
    await rm(directory, { recursive: true, force: true });
  }
});

describe("FileEnvironmentResolver", () => {
  describe("resolveDocument", () => {
    it("resolves document from active environment when present", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Default persona" });
      await setupEnvironment(root, "work", { PERSONALITY: "Work persona" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "work");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.source).toBe("active");
      expect(result.value.sourceEnvironment).toBe("work");
      expect(result.value.document.content).toBe("Work persona");
      expect(result.value.type).toBe("PERSONALITY");
    });

    it("falls back to default when active environment lacks the document", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", {
        PERSONALITY: "Default persona",
        USER: "Default user",
      });
      await setupEnvironment(root, "work", { PERSONALITY: "Work persona" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("USER", "work");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.source).toBe("default");
      expect(result.value.sourceEnvironment).toBe("default");
      expect(result.value.document.content).toBe("Default user");
      expect(result.value.type).toBe("USER");
    });

    it("resolves document from default environment directly", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Default persona" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "default");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.source).toBe("active");
      expect(result.value.sourceEnvironment).toBe("default");
      expect(result.value.document.content).toBe("Default persona");
    });

    it("returns error when active environment directory does not exist", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Default persona" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "nonexistent");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("ENVIRONMENT_NOT_FOUND");
    });

    it("returns error when document is missing from both active and default", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", {});
      await setupEnvironment(root, "work", {});

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "work");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("DOCUMENT_NOT_FOUND");
    });

    it("returns error for invalid environment name", async () => {
      const root = await createTempEnvironmentsRoot();

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "../escape");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("INVALID_ENVIRONMENT_NAME");
    });

    it("returns error for empty environment name", async () => {
      const root = await createTempEnvironmentsRoot();

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("INVALID_ENVIRONMENT_NAME");
    });

    it("returns error for environment name with spaces", async () => {
      const root = await createTempEnvironmentsRoot();

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "my env");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("INVALID_ENVIRONMENT_NAME");
    });

    it("uses full-file replacement — no merge with default content", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", {
        PERSONALITY: "# Default\nLine 1\nLine 2\nLine 3",
      });
      await setupEnvironment(root, "work", {
        PERSONALITY: "# Work\nOnly this content",
      });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "work");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.document.content).toBe("# Work\nOnly this content");
      expect(result.value.document.content).not.toContain("Default");
      expect(result.value.document.content).not.toContain("Line 1");
    });

    it("includes correct file path in resolved document", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { USER: "User info" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("USER", "default");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.document.path).toBe(join(root, "default", "USER.md"));
    });

    it("includes loadedAt timestamp in resolved document", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Content" });

      const before = new Date();
      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "default");
      const after = new Date();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.document.loadedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(result.value.document.loadedAt.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("returns error when default directory is missing for fallback", async () => {
      const root = await createTempEnvironmentsRoot();
      // Create work env but no default
      await setupEnvironment(root, "work", {});

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "work");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("ENVIRONMENT_NOT_FOUND");
    });
  });

  describe("resolveAll", () => {
    it("resolves all documents from default when no overrides exist", async () => {
      const root = await createTempEnvironmentsRoot();
      const defaultDocs: Record<string, string> = {};
      for (const docType of ENVIRONMENT_DOCUMENTS) {
        defaultDocs[docType] = `Default ${docType} content`;
      }
      await setupEnvironment(root, "default", defaultDocs);
      await setupEnvironment(root, "work", {});

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveAll("work");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.activeEnvironment).toBe("work");
      expect(result.value.fallbackEnvironment).toBe("default");

      for (const docType of ENVIRONMENT_DOCUMENTS) {
        const doc = result.value.documents[docType];
        expect(doc.source).toBe("default");
        expect(doc.sourceEnvironment).toBe("default");
        expect(doc.document.content).toBe(`Default ${docType} content`);
      }
    });

    it("resolves with partial overlay — some active, some default", async () => {
      const root = await createTempEnvironmentsRoot();
      const defaultDocs: Record<string, string> = {};
      for (const docType of ENVIRONMENT_DOCUMENTS) {
        defaultDocs[docType] = `Default ${docType}`;
      }
      await setupEnvironment(root, "default", defaultDocs);
      await setupEnvironment(root, "work", {
        PERSONALITY: "Work personality",
        BOUNDARIES: "Work boundaries",
      });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveAll("work");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Overridden docs come from active
      expect(result.value.documents.PERSONALITY.source).toBe("active");
      expect(result.value.documents.PERSONALITY.sourceEnvironment).toBe("work");
      expect(result.value.documents.PERSONALITY.document.content).toBe("Work personality");

      expect(result.value.documents.BOUNDARIES.source).toBe("active");
      expect(result.value.documents.BOUNDARIES.sourceEnvironment).toBe("work");
      expect(result.value.documents.BOUNDARIES.document.content).toBe("Work boundaries");

      // Non-overridden docs fall back to default
      expect(result.value.documents.USER.source).toBe("default");
      expect(result.value.documents.USER.sourceEnvironment).toBe("default");
      expect(result.value.documents.USER.document.content).toBe("Default USER");

      expect(result.value.documents.HEARTBEAT.source).toBe("default");
      expect(result.value.documents.ROUTINES.source).toBe("default");
      expect(result.value.documents.GOALS.source).toBe("default");
      expect(result.value.documents.KNOWLEDGE.source).toBe("default");
      expect(result.value.documents.TOOLS.source).toBe("default");
    });

    it("resolves all documents from default when environment is default", async () => {
      const root = await createTempEnvironmentsRoot();
      const defaultDocs: Record<string, string> = {};
      for (const docType of ENVIRONMENT_DOCUMENTS) {
        defaultDocs[docType] = `Default ${docType}`;
      }
      await setupEnvironment(root, "default", defaultDocs);

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveAll("default");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.activeEnvironment).toBe("default");

      for (const docType of ENVIRONMENT_DOCUMENTS) {
        const doc = result.value.documents[docType];
        expect(doc.source).toBe("active");
        expect(doc.sourceEnvironment).toBe("default");
      }
    });

    it("resolves all documents from active when full doc set exists", async () => {
      const root = await createTempEnvironmentsRoot();
      const defaultDocs: Record<string, string> = {};
      const workDocs: Record<string, string> = {};
      for (const docType of ENVIRONMENT_DOCUMENTS) {
        defaultDocs[docType] = `Default ${docType}`;
        workDocs[docType] = `Work ${docType}`;
      }
      await setupEnvironment(root, "default", defaultDocs);
      await setupEnvironment(root, "work", workDocs);

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveAll("work");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      for (const docType of ENVIRONMENT_DOCUMENTS) {
        const doc = result.value.documents[docType];
        expect(doc.source).toBe("active");
        expect(doc.sourceEnvironment).toBe("work");
        expect(doc.document.content).toBe(`Work ${docType}`);
      }
    });

    it("returns error when active environment does not exist", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Default" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveAll("nonexistent");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("ENVIRONMENT_NOT_FOUND");
    });

    it("returns error when default environment is missing", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "work", { PERSONALITY: "Work" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveAll("work");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("ENVIRONMENT_NOT_FOUND");
    });

    it("returns error when a required document is missing from both environments", async () => {
      const root = await createTempEnvironmentsRoot();
      // Default has only PERSONALITY, missing all others
      await setupEnvironment(root, "default", { PERSONALITY: "Default persona" });
      await setupEnvironment(root, "work", {});

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveAll("work");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("DOCUMENT_NOT_FOUND");
    });

    it("returns error for invalid environment name", async () => {
      const root = await createTempEnvironmentsRoot();

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveAll("Bad Name!");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("INVALID_ENVIRONMENT_NAME");
    });
  });

  describe("listEnvironments", () => {
    it("returns empty array when environments root does not exist", async () => {
      const root = join(tmpdir(), "reins-nonexistent-" + Date.now());

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.listEnvironments();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toEqual([]);
    });

    it("lists all environment directories", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Default" });
      await setupEnvironment(root, "work", { PERSONALITY: "Work" });
      await setupEnvironment(root, "creative", { PERSONALITY: "Creative" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.listEnvironments();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const names = result.value.map((env) => env.name);
      expect(names).toContain("default");
      expect(names).toContain("work");
      expect(names).toContain("creative");
      expect(names.length).toBe(3);
    });

    it("sorts default environment first", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "work", { PERSONALITY: "Work" });
      await setupEnvironment(root, "default", { PERSONALITY: "Default" });
      await setupEnvironment(root, "alpha", { PERSONALITY: "Alpha" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.listEnvironments();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value[0].name).toBe("default");
      expect(result.value[1].name).toBe("alpha");
      expect(result.value[2].name).toBe("work");
    });

    it("includes document content map for each environment", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", {
        PERSONALITY: "Default persona",
        USER: "Default user",
      });
      await setupEnvironment(root, "work", {
        PERSONALITY: "Work persona",
      });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.listEnvironments();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const defaultEnv = result.value.find((env) => env.name === "default");
      expect(defaultEnv).toBeDefined();
      expect(defaultEnv!.documents.PERSONALITY).toBe("Default persona");
      expect(defaultEnv!.documents.USER).toBe("Default user");
      expect(defaultEnv!.documents.HEARTBEAT).toBeUndefined();

      const workEnv = result.value.find((env) => env.name === "work");
      expect(workEnv).toBeDefined();
      expect(workEnv!.documents.PERSONALITY).toBe("Work persona");
      expect(workEnv!.documents.USER).toBeUndefined();
    });

    it("includes correct path for each environment", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", {});
      await setupEnvironment(root, "work", {});

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.listEnvironments();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const defaultEnv = result.value.find((env) => env.name === "default");
      expect(defaultEnv!.path).toBe(join(root, "default"));

      const workEnv = result.value.find((env) => env.name === "work");
      expect(workEnv!.path).toBe(join(root, "work"));
    });

    it("ignores non-directory entries in environments root", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Default" });
      // Create a regular file that should be ignored
      await writeFile(join(root, "README.md"), "Not an environment", "utf8");

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.listEnvironments();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const names = result.value.map((env) => env.name);
      expect(names).toEqual(["default"]);
    });

    it("ignores directories with invalid names", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Default" });
      await setupEnvironment(root, "work", { PERSONALITY: "Work" });
      // Create directories with invalid names
      await mkdir(join(root, ".hidden"), { recursive: true });
      await mkdir(join(root, "Has Spaces"), { recursive: true });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.listEnvironments();

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const names = result.value.map((env) => env.name);
      expect(names).toContain("default");
      expect(names).toContain("work");
      expect(names).not.toContain(".hidden");
      expect(names).not.toContain("Has Spaces");
      expect(names.length).toBe(2);
    });
  });

  describe("provenance tracking", () => {
    it("tracks active source for overridden documents", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", {
        PERSONALITY: "Default",
        USER: "Default user",
      });
      await setupEnvironment(root, "work", {
        PERSONALITY: "Work",
      });

      const resolver = new FileEnvironmentResolver(root);

      const personality = await resolver.resolveDocument("PERSONALITY", "work");
      expect(personality.ok).toBe(true);
      if (!personality.ok) return;
      expect(personality.value.source).toBe("active");
      expect(personality.value.sourceEnvironment).toBe("work");

      const user = await resolver.resolveDocument("USER", "work");
      expect(user.ok).toBe(true);
      if (!user.ok) return;
      expect(user.value.source).toBe("default");
      expect(user.value.sourceEnvironment).toBe("default");
    });

    it("marks all documents as active when resolving default environment", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", {
        PERSONALITY: "Default persona",
        USER: "Default user",
      });

      const resolver = new FileEnvironmentResolver(root);

      const personality = await resolver.resolveDocument("PERSONALITY", "default");
      expect(personality.ok).toBe(true);
      if (!personality.ok) return;
      expect(personality.value.source).toBe("active");
      expect(personality.value.sourceEnvironment).toBe("default");

      const user = await resolver.resolveDocument("USER", "default");
      expect(user.ok).toBe(true);
      if (!user.ok) return;
      expect(user.value.source).toBe("active");
      expect(user.value.sourceEnvironment).toBe("default");
    });

    it("resolveAll provenance matches individual resolveDocument calls", async () => {
      const root = await createTempEnvironmentsRoot();
      const defaultDocs: Record<string, string> = {};
      for (const docType of ENVIRONMENT_DOCUMENTS) {
        defaultDocs[docType] = `Default ${docType}`;
      }
      await setupEnvironment(root, "default", defaultDocs);
      await setupEnvironment(root, "work", {
        PERSONALITY: "Work personality",
        GOALS: "Work goals",
      });

      const resolver = new FileEnvironmentResolver(root);
      const allResult = await resolver.resolveAll("work");

      expect(allResult.ok).toBe(true);
      if (!allResult.ok) return;

      // Verify each document's provenance individually
      for (const docType of ENVIRONMENT_DOCUMENTS) {
        const individual = await resolver.resolveDocument(docType, "work");
        expect(individual.ok).toBe(true);
        if (!individual.ok) return;

        const fromAll = allResult.value.documents[docType];
        expect(fromAll.source).toBe(individual.value.source);
        expect(fromAll.sourceEnvironment).toBe(individual.value.sourceEnvironment);
        expect(fromAll.document.content).toBe(individual.value.document.content);
      }
    });
  });

  describe("environment name validation", () => {
    it("accepts valid lowercase names with hyphens and underscores", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Default" });
      await setupEnvironment(root, "my-work-env", { PERSONALITY: "Work" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "my-work-env");

      expect(result.ok).toBe(true);
    });

    it("accepts names with underscores", async () => {
      const root = await createTempEnvironmentsRoot();
      await setupEnvironment(root, "default", { PERSONALITY: "Default" });
      await setupEnvironment(root, "work_env", { PERSONALITY: "Work" });

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "work_env");

      expect(result.ok).toBe(true);
    });

    it("rejects names starting with a number", async () => {
      const root = await createTempEnvironmentsRoot();

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "1work");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INVALID_ENVIRONMENT_NAME");
    });

    it("rejects names with uppercase letters", async () => {
      const root = await createTempEnvironmentsRoot();

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "Work");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INVALID_ENVIRONMENT_NAME");
    });

    it("rejects names with dots", async () => {
      const root = await createTempEnvironmentsRoot();

      const resolver = new FileEnvironmentResolver(root);
      const result = await resolver.resolveDocument("PERSONALITY", "my.env");

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe("INVALID_ENVIRONMENT_NAME");
    });
  });
});
