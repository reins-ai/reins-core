import { describe, expect, it } from "bun:test";
import {
  DocumentSourceRegistry,
  DocumentSourceRegistryError,
  generateSourceIdForTesting,
  type DocumentSource,
} from "../../../src/memory/rag/document-source-registry";
import {
  DEFAULT_SOURCE_POLICY,
  matchesPolicy,
  type DocumentSourcePolicy,
} from "../../../src/memory/rag/document-source-policy";

describe("DocumentSourcePolicy", () => {
  describe("DEFAULT_SOURCE_POLICY", () => {
    it("includes markdown files by default", () => {
      expect(DEFAULT_SOURCE_POLICY.includePaths).toEqual(["**/*.md"]);
    });

    it("excludes common non-content directories", () => {
      expect(DEFAULT_SOURCE_POLICY.excludePaths).toContain("**/node_modules/**");
      expect(DEFAULT_SOURCE_POLICY.excludePaths).toContain("**/.git/**");
      expect(DEFAULT_SOURCE_POLICY.excludePaths).toContain("**/dist/**");
    });

    it("has sensible size and depth defaults", () => {
      expect(DEFAULT_SOURCE_POLICY.maxFileSize).toBe(1_048_576);
      expect(DEFAULT_SOURCE_POLICY.maxDepth).toBe(10);
      expect(DEFAULT_SOURCE_POLICY.watchForChanges).toBe(true);
    });
  });

  describe("matchesPolicy", () => {
    const defaultPolicy = DEFAULT_SOURCE_POLICY;

    it("matches markdown files in root", () => {
      expect(matchesPolicy("README.md", defaultPolicy)).toBe(true);
    });

    it("matches markdown files in subdirectories", () => {
      expect(matchesPolicy("docs/guide.md", defaultPolicy)).toBe(true);
      expect(matchesPolicy("a/b/c/deep.md", defaultPolicy)).toBe(true);
    });

    it("rejects non-markdown files with default policy", () => {
      expect(matchesPolicy("src/index.ts", defaultPolicy)).toBe(false);
      expect(matchesPolicy("package.json", defaultPolicy)).toBe(false);
    });

    it("rejects files in excluded directories", () => {
      expect(matchesPolicy("node_modules/pkg/README.md", defaultPolicy)).toBe(false);
      expect(matchesPolicy(".git/HEAD", defaultPolicy)).toBe(false);
      expect(matchesPolicy("dist/output.md", defaultPolicy)).toBe(false);
    });

    it("handles paths with leading ./", () => {
      expect(matchesPolicy("./docs/guide.md", defaultPolicy)).toBe(true);
      expect(matchesPolicy("./node_modules/pkg/README.md", defaultPolicy)).toBe(false);
    });

    it("handles backslash paths", () => {
      expect(matchesPolicy("docs\\guide.md", defaultPolicy)).toBe(true);
      expect(matchesPolicy("node_modules\\pkg\\README.md", defaultPolicy)).toBe(false);
    });

    it("matches all files when includePaths is empty", () => {
      const policy: DocumentSourcePolicy = {
        ...defaultPolicy,
        includePaths: [],
        excludePaths: [],
      };
      expect(matchesPolicy("anything.txt", policy)).toBe(true);
      expect(matchesPolicy("src/code.ts", policy)).toBe(true);
    });

    it("applies excludes even when includePaths is empty", () => {
      const policy: DocumentSourcePolicy = {
        ...defaultPolicy,
        includePaths: [],
        excludePaths: ["**/secret/**"],
      };
      expect(matchesPolicy("public/file.txt", policy)).toBe(true);
      expect(matchesPolicy("secret/keys.txt", policy)).toBe(false);
    });

    it("supports multiple include patterns", () => {
      const policy: DocumentSourcePolicy = {
        ...defaultPolicy,
        includePaths: ["**/*.md", "**/*.txt"],
        excludePaths: [],
      };
      expect(matchesPolicy("notes.md", policy)).toBe(true);
      expect(matchesPolicy("notes.txt", policy)).toBe(true);
      expect(matchesPolicy("notes.ts", policy)).toBe(false);
    });

    it("excludes take priority over includes", () => {
      const policy: DocumentSourcePolicy = {
        ...defaultPolicy,
        includePaths: ["**/*.md"],
        excludePaths: ["drafts/**/*.md"],
      };
      expect(matchesPolicy("docs/guide.md", policy)).toBe(true);
      expect(matchesPolicy("drafts/wip.md", policy)).toBe(false);
    });
  });
});

describe("DocumentSourceRegistry", () => {
  function createRegistry(sources?: DocumentSource[]): DocumentSourceRegistry {
    return new DocumentSourceRegistry(sources);
  }

  describe("register", () => {
    it("registers a new source with default policy", () => {
      const registry = createRegistry();
      const result = registry.register("/home/user/docs");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.rootPath).toBe("/home/user/docs");
      expect(result.value.name).toBe("docs");
      expect(result.value.status).toBe("registered");
      expect(result.value.policy).toEqual(DEFAULT_SOURCE_POLICY);
      expect(result.value.id).toBeTruthy();
      expect(result.value.registeredAt).toBeTruthy();
      expect(result.value.updatedAt).toBeTruthy();
    });

    it("registers with a custom name", () => {
      const registry = createRegistry();
      const result = registry.register("/home/user/docs", { name: "My Documents" });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe("My Documents");
    });

    it("registers with a custom policy", () => {
      const registry = createRegistry();
      const result = registry.register("/home/user/docs", {
        policy: {
          includePaths: ["**/*.txt", "**/*.md"],
          maxFileSize: 512_000,
          watchForChanges: false,
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.policy.includePaths).toEqual(["**/*.txt", "**/*.md"]);
      expect(result.value.policy.maxFileSize).toBe(512_000);
      expect(result.value.policy.watchForChanges).toBe(false);
      // Defaults preserved for unspecified fields
      expect(result.value.policy.excludePaths).toEqual(DEFAULT_SOURCE_POLICY.excludePaths);
      expect(result.value.policy.maxDepth).toBe(DEFAULT_SOURCE_POLICY.maxDepth);
    });

    it("rejects duplicate registration of the same path", () => {
      const registry = createRegistry();
      registry.register("/home/user/docs");
      const result = registry.register("/home/user/docs");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error).toBeInstanceOf(DocumentSourceRegistryError);
      expect(result.error.code).toBe("SOURCE_ALREADY_REGISTERED");
    });

    it("allows re-registration of a removed source", () => {
      const registry = createRegistry();
      const first = registry.register("/home/user/docs");
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      registry.unregister(first.value.id);
      const second = registry.register("/home/user/docs");

      expect(second.ok).toBe(true);
      if (!second.ok) return;

      expect(second.value.status).toBe("registered");
    });

    it("rejects empty rootPath", () => {
      const registry = createRegistry();
      const result = registry.register("");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("INVALID_ROOT_PATH");
    });

    it("rejects whitespace-only rootPath", () => {
      const registry = createRegistry();
      const result = registry.register("   ");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("INVALID_ROOT_PATH");
    });

    it("uses basename as default name", () => {
      const registry = createRegistry();
      const result = registry.register("/home/user/my-project/notes");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe("notes");
    });
  });

  describe("unregister", () => {
    it("marks a source as removed", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs");
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = registry.unregister(reg.value.id);
      expect(result.ok).toBe(true);

      const getResult = registry.get(reg.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      expect(getResult.value?.status).toBe("removed");
    });

    it("returns error for non-existent source", () => {
      const registry = createRegistry();
      const result = registry.unregister("nonexistent");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("SOURCE_NOT_FOUND");
    });

    it("returns error when unregistering an already removed source", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs");
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      registry.unregister(reg.value.id);
      const result = registry.unregister(reg.value.id);

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("SOURCE_ALREADY_REMOVED");
    });
  });

  describe("get", () => {
    it("returns a registered source by id", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs");
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = registry.get(reg.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).not.toBeNull();
      expect(result.value?.rootPath).toBe("/home/user/docs");
    });

    it("returns null for non-existent id", () => {
      const registry = createRegistry();
      const result = registry.get("nonexistent");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeNull();
    });
  });

  describe("list", () => {
    it("returns all sources when no filter is provided", () => {
      const registry = createRegistry();
      registry.register("/home/user/docs");
      registry.register("/home/user/notes");

      const sources = registry.list();
      expect(sources).toHaveLength(2);
    });

    it("filters sources by status", () => {
      const registry = createRegistry();
      const reg1 = registry.register("/home/user/docs");
      registry.register("/home/user/notes");

      expect(reg1.ok).toBe(true);
      if (!reg1.ok) return;

      registry.updateStatus(reg1.value.id, "indexed", {
        lastIndexedAt: new Date().toISOString(),
        fileCount: 10,
      });

      const registered = registry.list({ status: "registered" });
      expect(registered).toHaveLength(1);
      expect(registered[0].rootPath).toBe("/home/user/notes");

      const indexed = registry.list({ status: "indexed" });
      expect(indexed).toHaveLength(1);
      expect(indexed[0].rootPath).toBe("/home/user/docs");
    });

    it("returns empty array when no sources match filter", () => {
      const registry = createRegistry();
      registry.register("/home/user/docs");

      const results = registry.list({ status: "error" });
      expect(results).toHaveLength(0);
    });

    it("returns empty array for empty registry", () => {
      const registry = createRegistry();
      expect(registry.list()).toHaveLength(0);
    });
  });

  describe("updateStatus", () => {
    it("updates status to indexing", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs");
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = registry.updateStatus(reg.value.id, "indexing");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.status).toBe("indexing");
      expect(typeof result.value.updatedAt).toBe("string");
    });

    it("updates status with metadata", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs");
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const indexedAt = "2026-02-13T12:00:00.000Z";
      const result = registry.updateStatus(reg.value.id, "indexed", {
        lastIndexedAt: indexedAt,
        fileCount: 42,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.status).toBe("indexed");
      expect(result.value.lastIndexedAt).toBe(indexedAt);
      expect(result.value.fileCount).toBe(42);
    });

    it("updates status to error with error message", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs");
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = registry.updateStatus(reg.value.id, "error", {
        errorMessage: "Permission denied",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.status).toBe("error");
      expect(result.value.errorMessage).toBe("Permission denied");
    });

    it("returns error for non-existent source", () => {
      const registry = createRegistry();
      const result = registry.updateStatus("nonexistent", "indexed");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("SOURCE_NOT_FOUND");
    });

    it("preserves existing fields when updating status", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs", { name: "My Docs" });
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = registry.updateStatus(reg.value.id, "indexing");
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.name).toBe("My Docs");
      expect(result.value.rootPath).toBe("/home/user/docs");
      expect(result.value.policy).toEqual(DEFAULT_SOURCE_POLICY);
    });
  });

  describe("checkpoint", () => {
    it("saves and retrieves a checkpoint", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs");
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const saveResult = registry.saveCheckpoint(reg.value.id, "cursor:abc123");
      expect(saveResult.ok).toBe(true);

      const getResult = registry.getCheckpoint(reg.value.id);
      expect(getResult.ok).toBe(true);
      if (!getResult.ok) return;

      expect(getResult.value).toBe("cursor:abc123");
    });

    it("returns null checkpoint for source without checkpoint", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs");
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      const result = registry.getCheckpoint(reg.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBeNull();
    });

    it("overwrites existing checkpoint", () => {
      const registry = createRegistry();
      const reg = registry.register("/home/user/docs");
      expect(reg.ok).toBe(true);
      if (!reg.ok) return;

      registry.saveCheckpoint(reg.value.id, "cursor:first");
      registry.saveCheckpoint(reg.value.id, "cursor:second");

      const result = registry.getCheckpoint(reg.value.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).toBe("cursor:second");
    });

    it("returns error for non-existent source on getCheckpoint", () => {
      const registry = createRegistry();
      const result = registry.getCheckpoint("nonexistent");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("SOURCE_NOT_FOUND");
    });

    it("returns error for non-existent source on saveCheckpoint", () => {
      const registry = createRegistry();
      const result = registry.saveCheckpoint("nonexistent", "cursor:abc");

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.code).toBe("SOURCE_NOT_FOUND");
    });
  });

  describe("deterministic ID generation", () => {
    it("generates the same ID for the same path", () => {
      const id1 = generateSourceIdForTesting("/home/user/docs");
      const id2 = generateSourceIdForTesting("/home/user/docs");
      expect(id1).toBe(id2);
    });

    it("generates different IDs for different paths", () => {
      const id1 = generateSourceIdForTesting("/home/user/docs");
      const id2 = generateSourceIdForTesting("/home/user/notes");
      expect(id1).not.toBe(id2);
    });

    it("normalizes trailing slashes", () => {
      const id1 = generateSourceIdForTesting("/home/user/docs");
      const id2 = generateSourceIdForTesting("/home/user/docs/");
      expect(id1).toBe(id2);
    });

    it("normalizes backslashes to forward slashes", () => {
      const id1 = generateSourceIdForTesting("/home/user/docs");
      const id2 = generateSourceIdForTesting("\\home\\user\\docs");
      expect(id1).toBe(id2);
    });

    it("produces a 16-character hex string", () => {
      const id = generateSourceIdForTesting("/some/path");
      expect(id).toHaveLength(16);
      expect(/^[0-9a-f]{16}$/.test(id)).toBe(true);
    });
  });

  describe("constructor with initial sources", () => {
    it("restores sources from initial data", () => {
      const now = new Date().toISOString();
      const sources: DocumentSource[] = [
        {
          id: "abc123",
          rootPath: "/home/user/docs",
          name: "docs",
          policy: DEFAULT_SOURCE_POLICY,
          status: "indexed",
          lastIndexedAt: now,
          fileCount: 5,
          registeredAt: now,
          updatedAt: now,
        },
      ];

      const registry = createRegistry(sources);
      const result = registry.get("abc123");

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value).not.toBeNull();
      expect(result.value?.rootPath).toBe("/home/user/docs");
      expect(result.value?.status).toBe("indexed");
    });

    it("lists restored sources", () => {
      const now = new Date().toISOString();
      const sources: DocumentSource[] = [
        {
          id: "abc",
          rootPath: "/a",
          name: "a",
          policy: DEFAULT_SOURCE_POLICY,
          status: "registered",
          registeredAt: now,
          updatedAt: now,
        },
        {
          id: "def",
          rootPath: "/b",
          name: "b",
          policy: DEFAULT_SOURCE_POLICY,
          status: "indexed",
          registeredAt: now,
          updatedAt: now,
        },
      ];

      const registry = createRegistry(sources);
      expect(registry.list()).toHaveLength(2);
      expect(registry.list({ status: "indexed" })).toHaveLength(1);
    });
  });
});
