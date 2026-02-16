import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { IntegrationError } from "../../../../src/integrations/errors";
import { validateIntegrationManifest } from "../../../../src/integrations/manifest";
import { InMemoryCredentialVault } from "../../../../src/integrations/credentials/vault";
import { IntegrationState } from "../../../../src/integrations/types";
import {
  ObsidianIntegration,
  loadObsidianManifest,
  resetManifestCacheForTests,
} from "../../../../src/integrations/adapters/obsidian/index";
import { validateVaultPath, ObsidianAuth } from "../../../../src/integrations/adapters/obsidian/auth";
import { searchNotes } from "../../../../src/integrations/adapters/obsidian/operations/search-notes";
import { readNote } from "../../../../src/integrations/adapters/obsidian/operations/read-note";
import { createNote } from "../../../../src/integrations/adapters/obsidian/operations/create-note";
import { listNotes } from "../../../../src/integrations/adapters/obsidian/operations/list-notes";
import { connect } from "../../../../src/integrations/adapters/obsidian/operations/connect";
import { disconnect } from "../../../../src/integrations/adapters/obsidian/operations/disconnect";
import type { IntegrationResult } from "../../../../src/integrations/result";

// ---------------------------------------------------------------------------
// Test vault helpers
// ---------------------------------------------------------------------------

let testVaultPath: string;

async function createTestVault(): Promise<string> {
  const base = join(tmpdir(), `reins-obsidian-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(base, { recursive: true });

  // Root-level notes
  await writeFile(join(base, "welcome.md"), "# Welcome\n\nThis is the welcome note.");
  await writeFile(join(base, "daily-log.md"), "# Daily Log\n\nToday I worked on testing.");
  await writeFile(
    join(base, "project-ideas.md"),
    "# Project Ideas\n\n- Build a CLI tool\n- Create a web dashboard\n- Write integration tests",
  );

  // Subdirectory with notes
  const subDir = join(base, "journal");
  await mkdir(subDir, { recursive: true });
  await writeFile(join(subDir, "2026-02-15.md"), "# February 15\n\nWorked on Reins integrations.");
  await writeFile(join(subDir, "2026-02-14.md"), "# February 14\n\nPlanned the integration system.");

  // Nested subdirectory
  const nestedDir = join(base, "projects", "reins");
  await mkdir(nestedDir, { recursive: true });
  await writeFile(join(nestedDir, "architecture.md"), "# Architecture\n\nDaemon-centric execution model.");

  // Hidden directory (should be skipped by operations)
  const hiddenDir = join(base, ".obsidian");
  await mkdir(hiddenDir, { recursive: true });
  await writeFile(join(hiddenDir, "config.md"), "# Config\n\nThis should be ignored.");

  return base;
}

async function removeTestVault(vaultPath: string): Promise<void> {
  try {
    await rm(vaultPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup
  }
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  testVaultPath = await createTestVault();
  resetManifestCacheForTests();
});

afterEach(async () => {
  await removeTestVault(testVaultPath);
});

// ---------------------------------------------------------------------------
// Manifest validation
// ---------------------------------------------------------------------------

describe("ObsidianManifest", () => {
  it("loads and validates the manifest from disk", async () => {
    const result = await loadObsidianManifest();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const manifest = result.value;
    expect(manifest.id).toBe("obsidian");
    expect(manifest.name).toBe("Obsidian");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.category).toBe("productivity");
    expect(manifest.auth.type).toBe("local_path");
    expect(manifest.platforms).toContain("daemon");
    expect(manifest.operations).toHaveLength(6);
  });

  it("passes validateIntegrationManifest with the raw JSON", async () => {
    const manifestPath = join(import.meta.dir, "../../../../src/integrations/adapters/obsidian/manifest.json");
    const raw = JSON.parse(await readFile(manifestPath, "utf-8"));
    const result = validateIntegrationManifest(raw);
    expect(result.valid).toBe(true);
  });

  it("includes all operations in the manifest", async () => {
    const result = await loadObsidianManifest();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const opNames = result.value.operations.map((op) => op.name);
    expect(opNames).toContain("connect");
    expect(opNames).toContain("disconnect");
    expect(opNames).toContain("search-notes");
    expect(opNames).toContain("read-note");
    expect(opNames).toContain("create-note");
    expect(opNames).toContain("list-notes");
  });
});

// ---------------------------------------------------------------------------
// connect operation
// ---------------------------------------------------------------------------

describe("connect", () => {
  it("connects to a valid vault and returns dual-channel success", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new ObsidianAuth({ vault });

    const result = await connect(auth, { vault_path: testVaultPath });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value;
    const modelData = data.forModel.data as { connected: boolean; path: string };
    expect(modelData.connected).toBe(true);
    expect(modelData.path).toBe(testVaultPath);
    expect(data.forUser.message).toContain(`Connected to Obsidian vault at ${testVaultPath}`);

    const status = auth.getStatus();
    expect(status.state).toBe(IntegrationState.CONNECTED);
  });

  it("rejects an empty vault_path", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new ObsidianAuth({ vault });

    const result = await connect(auth, { vault_path: "   " });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("vault_path");
  });
});

describe("disconnect", () => {
  it("disconnects and returns dual-channel success", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new ObsidianAuth({ vault });

    await auth.connect(testVaultPath);

    const result = await disconnect(auth);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const modelData = result.value.forModel.data as { connected: boolean };
    expect(modelData.connected).toBe(false);
    expect(result.value.forUser.message).toContain("cleared saved vault credentials");
  });
});

// ---------------------------------------------------------------------------
// Auth handler
// ---------------------------------------------------------------------------

describe("ObsidianAuth", () => {
  it("connects with a valid vault path", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new ObsidianAuth({ vault });

    const result = await auth.connect(testVaultPath);
    expect(result.ok).toBe(true);

    const status = auth.getStatus();
    expect(status.state).toBe(IntegrationState.CONNECTED);
    expect(status.indicator).toBe("connected");
  });

  it("rejects a path that does not exist", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new ObsidianAuth({ vault });

    const result = await auth.connect("/nonexistent/path/to/vault");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("does not exist");
  });

  it("rejects an empty vault path", async () => {
    const result = await validateVaultPath("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must not be empty");
  });

  it("rejects a whitespace-only vault path", async () => {
    const result = await validateVaultPath("   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must not be empty");
  });

  it("rejects a directory without .md files", async () => {
    const emptyDir = join(tmpdir(), `reins-empty-vault-${Date.now()}`);
    await mkdir(emptyDir, { recursive: true });
    await writeFile(join(emptyDir, "readme.txt"), "not markdown");

    try {
      const result = await validateVaultPath(emptyDir);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("does not contain any Markdown");
    } finally {
      await removeTestVault(emptyDir);
    }
  });

  it("disconnects and clears stored credentials", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new ObsidianAuth({ vault });

    await auth.connect(testVaultPath);
    expect(auth.getStatus().state).toBe(IntegrationState.CONNECTED);

    const disconnectResult = await auth.disconnect();
    expect(disconnectResult.ok).toBe(true);
    expect(auth.getStatus().state).toBe(IntegrationState.DISCONNECTED);

    const hasCredentials = await vault.hasCredentials("obsidian");
    expect(hasCredentials.ok).toBe(true);
    if (hasCredentials.ok) {
      expect(hasCredentials.value).toBe(false);
    }
  });

  it("retrieves the stored vault path after connecting", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new ObsidianAuth({ vault });

    await auth.connect(testVaultPath);

    const pathResult = await auth.getVaultPath();
    expect(pathResult.ok).toBe(true);
    if (!pathResult.ok) return;
    expect(pathResult.value).toBe(testVaultPath);
  });

  it("returns null vault path when not connected", async () => {
    const vault = new InMemoryCredentialVault();
    const auth = new ObsidianAuth({ vault });

    const pathResult = await auth.getVaultPath();
    expect(pathResult.ok).toBe(true);
    if (!pathResult.ok) return;
    expect(pathResult.value).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// search-notes operation
// ---------------------------------------------------------------------------

describe("searchNotes", () => {
  it("finds notes by title", async () => {
    const result = await searchNotes(testVaultPath, { query: "welcome" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    expect(modelItems.length).toBeGreaterThanOrEqual(1);

    const match = modelItems[0] as { title: string; path: string; matchType: string };
    expect(match.title.toLowerCase()).toContain("welcome");
  });

  it("finds notes by content", async () => {
    const result = await searchNotes(testVaultPath, { query: "CLI tool" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    expect(modelItems.length).toBeGreaterThanOrEqual(1);

    const match = modelItems[0] as { title: string; matchType: string };
    expect(match.title).toBe("project-ideas");
    expect(match.matchType).toBe("content");
  });

  it("returns empty results when no notes match", async () => {
    const result = await searchNotes(testVaultPath, { query: "xyznonexistent" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(0);
    expect(data.forModel.summary).toContain("No");
  });

  it("respects the limit parameter", async () => {
    const result = await searchNotes(testVaultPath, { query: "the", limit: 2 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    expect(modelItems.length).toBeLessThanOrEqual(2);
  });

  it("rejects an empty query", async () => {
    const result = await searchNotes(testVaultPath, { query: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("must not be empty");
  });

  it("searches recursively into subdirectories", async () => {
    const result = await searchNotes(testVaultPath, { query: "Reins integrations" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    const paths = modelItems.map((item: unknown) => (item as { path: string }).path);
    const hasSubdirResult = paths.some((p: string) => p.includes("/"));
    expect(hasSubdirResult).toBe(true);
  });

  it("skips hidden directories like .obsidian", async () => {
    const result = await searchNotes(testVaultPath, { query: "Config" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    const paths = modelItems.map((item: unknown) => (item as { path: string }).path);
    const hasHidden = paths.some((p: string) => p.includes(".obsidian"));
    expect(hasHidden).toBe(false);
  });

  it("detects both title and content matches", async () => {
    // "welcome" appears in the filename (welcome.md → title "welcome")
    // and in the content ("This is the welcome note.")
    const result = await searchNotes(testVaultPath, { query: "welcome" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    const match = modelItems.find(
      (item: unknown) => (item as { title: string }).title === "welcome",
    ) as { matchType: string } | undefined;
    expect(match).toBeDefined();
    expect(match!.matchType).toBe("both");
  });
});

// ---------------------------------------------------------------------------
// read-note operation
// ---------------------------------------------------------------------------

describe("readNote", () => {
  it("reads an existing note at the vault root", async () => {
    const result = await readNote(testVaultPath, { path: "welcome.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.kind).toBe("detail");

    const modelData = data.forModel.data as { path: string; title: string; length: number };
    expect(modelData.path).toBe("welcome.md");
    expect(modelData.title).toBe("welcome");
    expect(modelData.length).toBeGreaterThan(0);
  });

  it("reads a note in a subdirectory", async () => {
    const result = await readNote(testVaultPath, { path: "journal/2026-02-15.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const userData = data.forUser.data as { content: string; path: string };
    expect(userData.path).toBe("journal/2026-02-15.md");
    expect(userData.content).toContain("Reins integrations");
  });

  it("reads a note in a nested subdirectory", async () => {
    const result = await readNote(testVaultPath, { path: "projects/reins/architecture.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const userData = data.forUser.data as { content: string };
    expect(userData.content).toContain("Daemon-centric");
  });

  it("returns an error for a missing note", async () => {
    const result = await readNote(testVaultPath, { path: "nonexistent.md" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("not found");
  });

  it("rejects an empty path", async () => {
    const result = await readNote(testVaultPath, { path: "" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must not be empty");
  });

  it("rejects path traversal attempts", async () => {
    const result = await readNote(testVaultPath, { path: "../../etc/passwd" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("within the vault");
  });
});

// ---------------------------------------------------------------------------
// create-note operation
// ---------------------------------------------------------------------------

describe("createNote", () => {
  it("creates a new note at the vault root", async () => {
    const result = await createNote(testVaultPath, {
      title: "New Note",
      content: "This is a brand new note.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { path: string; title: string };
    expect(modelData.title).toBe("New Note");
    expect(modelData.path).toBe("New Note.md");

    // Verify file was actually written
    const content = await readFile(join(testVaultPath, "New Note.md"), "utf-8");
    expect(content).toContain("# New Note");
    expect(content).toContain("This is a brand new note.");
  });

  it("creates a note in a specified folder", async () => {
    const result = await createNote(testVaultPath, {
      title: "Subfolder Note",
      content: "Note in a subfolder.",
      folder: "journal",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { path: string };
    expect(modelData.path).toBe(join("journal", "Subfolder Note.md"));

    const content = await readFile(join(testVaultPath, "journal", "Subfolder Note.md"), "utf-8");
    expect(content).toContain("Subfolder Note");
  });

  it("creates a note in a new nested directory", async () => {
    const result = await createNote(testVaultPath, {
      title: "Deep Note",
      content: "Deeply nested.",
      folder: "new-folder/sub-folder",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { path: string };
    expect(modelData.path).toBe(join("new-folder/sub-folder", "Deep Note.md"));

    const content = await readFile(
      join(testVaultPath, "new-folder", "sub-folder", "Deep Note.md"),
      "utf-8",
    );
    expect(content).toContain("Deeply nested.");
  });

  it("rejects creating a note that already exists", async () => {
    const result = await createNote(testVaultPath, {
      title: "welcome",
      content: "Duplicate.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("already exists");
  });

  it("rejects an empty title", async () => {
    const result = await createNote(testVaultPath, {
      title: "",
      content: "No title.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("must not be empty");
  });

  it("sanitizes invalid characters in the title", async () => {
    const result = await createNote(testVaultPath, {
      title: "My Note: A <Test>",
      content: "Sanitized title.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelData = data.forModel.data as { path: string };
    // Colons, angle brackets should be stripped
    expect(modelData.path).not.toContain(":");
    expect(modelData.path).not.toContain("<");
    expect(modelData.path).not.toContain(">");
  });

  it("rejects a title with only invalid characters", async () => {
    const result = await createNote(testVaultPath, {
      title: ":<>|?*",
      content: "Bad title.",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("invalid characters");
  });

  it("rejects path traversal in folder parameter", async () => {
    const result = await createNote(testVaultPath, {
      title: "Escape",
      content: "Trying to escape.",
      folder: "../../outside",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("within the vault");
  });
});

// ---------------------------------------------------------------------------
// list-notes operation
// ---------------------------------------------------------------------------

describe("listNotes", () => {
  it("lists notes at the vault root (non-recursive)", async () => {
    const result = await listNotes(testVaultPath, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    const titles = modelItems.map((item: unknown) => (item as { title: string }).title);

    expect(titles).toContain("welcome");
    expect(titles).toContain("daily-log");
    expect(titles).toContain("project-ideas");
    // Should NOT include subdirectory notes when non-recursive
    const paths = modelItems.map((item: unknown) => (item as { path: string }).path);
    const hasSubdirNote = paths.some((p: string) => p.includes("/"));
    expect(hasSubdirNote).toBe(false);
  });

  it("lists notes recursively", async () => {
    const result = await listNotes(testVaultPath, { recursive: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    const paths = modelItems.map((item: unknown) => (item as { path: string }).path);

    // Should include root notes
    expect(paths).toContain("welcome.md");
    // Should include subdirectory notes
    const hasJournalNote = paths.some((p: string) => p.startsWith("journal/"));
    expect(hasJournalNote).toBe(true);
    // Should include deeply nested notes
    const hasNestedNote = paths.some((p: string) => p.startsWith("projects/"));
    expect(hasNestedNote).toBe(true);
  });

  it("lists notes in a specific folder", async () => {
    const result = await listNotes(testVaultPath, { folder: "journal" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    expect(modelItems.length).toBe(2);

    const titles = modelItems.map((item: unknown) => (item as { title: string }).title);
    expect(titles).toContain("2026-02-15");
    expect(titles).toContain("2026-02-14");
  });

  it("returns empty list for an empty directory", async () => {
    const emptyDir = join(testVaultPath, "empty-folder");
    await mkdir(emptyDir, { recursive: true });

    const result = await listNotes(testVaultPath, { folder: "empty-folder" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    expect(data.forModel.count).toBe(0);
    expect(data.forUser.message).toContain("No notes found");
  });

  it("returns an error for a nonexistent folder", async () => {
    const result = await listNotes(testVaultPath, { folder: "nonexistent" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(IntegrationError);
    expect(result.error.message).toContain("not found");
  });

  it("skips hidden directories in recursive listing", async () => {
    const result = await listNotes(testVaultPath, { recursive: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelItems = (data.forModel.data as { items: unknown[] }).items;
    const paths = modelItems.map((item: unknown) => (item as { path: string }).path);
    const hasHidden = paths.some((p: string) => p.includes(".obsidian"));
    expect(hasHidden).toBe(false);
  });

  it("rejects path traversal in folder parameter", async () => {
    const result = await listNotes(testVaultPath, { folder: "../../etc" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("within the vault");
  });

  it("sorts notes by modification date (most recent first)", async () => {
    const result = await listNotes(testVaultPath, { folder: "journal" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const userItems = (data.forUser.data as { items: { modifiedAt: string }[] }).items;
    if (userItems.length >= 2) {
      const dates = userItems.map((item) => new Date(item.modifiedAt).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Dual-channel result verification
// ---------------------------------------------------------------------------

describe("DualChannelResults", () => {
  it("search-notes returns compact forModel and rich forUser", async () => {
    const result = await searchNotes(testVaultPath, { query: "welcome" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;

    // forModel should be compact
    expect(data.forModel.kind).toBe("list");
    expect(data.forModel.summary).toBeDefined();
    expect(data.forModel.count).toBeDefined();
    const modelItem = ((data.forModel.data as { items: unknown[] }).items[0]) as Record<string, unknown>;
    expect(modelItem).toHaveProperty("title");
    expect(modelItem).toHaveProperty("path");
    expect(modelItem).toHaveProperty("snippet");
    expect(modelItem).toHaveProperty("matchType");
    // forModel should NOT have full content
    expect(modelItem).not.toHaveProperty("fullContent");
    expect(modelItem).not.toHaveProperty("sizeBytes");

    // forUser should be rich
    expect(data.forUser.kind).toBe("list");
    expect(data.forUser.title).toBeDefined();
    expect(data.forUser.message).toBeDefined();
    expect(data.forUser.metadata).toBeDefined();
    const userItem = ((data.forUser.data as { items: unknown[] }).items[0]) as Record<string, unknown>;
    expect(userItem).toHaveProperty("fullContent");
    expect(userItem).toHaveProperty("sizeBytes");
    expect(userItem).toHaveProperty("modifiedAt");
  });

  it("read-note returns compact forModel and rich forUser", async () => {
    const result = await readNote(testVaultPath, { path: "welcome.md" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;

    // forModel should be compact (path, title, length — no content)
    expect(data.forModel.kind).toBe("detail");
    const modelData = data.forModel.data as Record<string, unknown>;
    expect(modelData).toHaveProperty("path");
    expect(modelData).toHaveProperty("title");
    expect(modelData).toHaveProperty("length");
    expect(modelData).not.toHaveProperty("content");

    // forUser should be rich (includes full content)
    expect(data.forUser.kind).toBe("detail");
    const userData = data.forUser.data as Record<string, unknown>;
    expect(userData).toHaveProperty("content");
    expect(userData).toHaveProperty("sizeBytes");
    expect(userData).toHaveProperty("modifiedAt");
    expect(userData).toHaveProperty("createdAt");
  });

  it("create-note returns compact forModel and rich forUser", async () => {
    const result = await createNote(testVaultPath, {
      title: "Dual Channel Test",
      content: "Testing dual channels.",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;

    // forModel should be compact (path, title — no content)
    expect(data.forModel.kind).toBe("detail");
    const modelData = data.forModel.data as Record<string, unknown>;
    expect(modelData).toHaveProperty("path");
    expect(modelData).toHaveProperty("title");
    expect(modelData).not.toHaveProperty("content");

    // forUser should be rich (includes content and metadata)
    expect(data.forUser.kind).toBe("detail");
    const userData = data.forUser.data as Record<string, unknown>;
    expect(userData).toHaveProperty("content");
    expect(userData).toHaveProperty("sizeBytes");
    expect(userData).toHaveProperty("createdAt");
  });

  it("list-notes returns compact forModel and rich forUser", async () => {
    const result = await listNotes(testVaultPath, { recursive: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;

    // forModel should be compact (title, path — no metadata)
    expect(data.forModel.kind).toBe("list");
    const modelItem = ((data.forModel.data as { items: unknown[] }).items[0]) as Record<string, unknown>;
    expect(modelItem).toHaveProperty("title");
    expect(modelItem).toHaveProperty("path");
    expect(modelItem).not.toHaveProperty("sizeBytes");
    expect(modelItem).not.toHaveProperty("modifiedAt");

    // forUser should be rich (includes metadata)
    expect(data.forUser.kind).toBe("list");
    expect(data.forUser.metadata).toBeDefined();
    const userItem = ((data.forUser.data as { items: unknown[] }).items[0]) as Record<string, unknown>;
    expect(userItem).toHaveProperty("sizeBytes");
    expect(userItem).toHaveProperty("modifiedAt");
    expect(userItem).toHaveProperty("createdAt");
    expect(userItem).toHaveProperty("isInSubfolder");
  });

  it("forModel token count is smaller than forUser for search results", async () => {
    const result = await searchNotes(testVaultPath, { query: "the" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.value as IntegrationResult;
    const modelJson = JSON.stringify(data.forModel);
    const userJson = JSON.stringify(data.forUser);

    // forModel should be meaningfully smaller than forUser
    expect(modelJson.length).toBeLessThan(userJson.length);
  });
});

// ---------------------------------------------------------------------------
// ObsidianIntegration (full integration class)
// ---------------------------------------------------------------------------

describe("ObsidianIntegration", () => {
  it("connects and executes search-notes via the integration interface", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    expect(manifestResult.ok).toBe(true);
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
    });

    const connectResult = await integration.execute("connect", { vault_path: testVaultPath });
    expect(connectResult.ok).toBe(true);

    const execResult = await integration.execute("search-notes", { query: "welcome" });
    expect(execResult.ok).toBe(true);
  });

  it("connects and executes read-note via the integration interface", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
    });

    await integration.execute("connect", { vault_path: testVaultPath });

    const execResult = await integration.execute("read-note", { path: "welcome.md" });
    expect(execResult.ok).toBe(true);
  });

  it("connects and executes create-note via the integration interface", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
    });

    await integration.execute("connect", { vault_path: testVaultPath });

    const execResult = await integration.execute("create-note", {
      title: "Integration Test",
      content: "Created via integration.execute().",
    });
    expect(execResult.ok).toBe(true);
  });

  it("connects and executes list-notes via the integration interface", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
    });

    await integration.execute("connect", { vault_path: testVaultPath });

    const execResult = await integration.execute("list-notes", {});
    expect(execResult.ok).toBe(true);
  });

  it("returns an error for an unknown operation", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
    });

    await integration.execute("connect", { vault_path: testVaultPath });

    const execResult = await integration.execute("unknown-op", {});
    expect(execResult.ok).toBe(false);
    if (execResult.ok) return;
    expect(execResult.error.message).toContain("Unknown Obsidian operation");
  });

  it("returns an error when executing without connecting first", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
      config: { settings: { vaultPath: testVaultPath } },
    });

    const execResult = await integration.execute("search-notes", { query: "test" });
    expect(execResult.ok).toBe(false);
    if (execResult.ok) return;
    expect(execResult.error.message).toContain("not connected");
  });

  it("returns an error when no vault path is configured", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
    });

    const connectResult = await integration.connect();
    expect(connectResult.ok).toBe(false);
    if (connectResult.ok) return;
    expect(connectResult.error.message).toContain("Vault path is required");
  });

  it("connects through execute with the connect operation", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
    });

    const connectResult = await integration.execute("connect", { vault_path: testVaultPath });
    expect(connectResult.ok).toBe(true);
    if (!connectResult.ok) return;

    const data = connectResult.value as IntegrationResult;
    const modelData = data.forModel.data as { connected: boolean; path: string };
    expect(modelData.connected).toBe(true);
    expect(modelData.path).toBe(testVaultPath);
  });

  it("disconnects through execute with the disconnect operation", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
    });

    const connectResult = await integration.execute("connect", { vault_path: testVaultPath });
    expect(connectResult.ok).toBe(true);

    const disconnectResult = await integration.execute("disconnect", {});
    expect(disconnectResult.ok).toBe(true);
    if (!disconnectResult.ok) return;

    const modelData = (disconnectResult.value as IntegrationResult).forModel.data as { connected: boolean };
    expect(modelData.connected).toBe(false);
  });

  it("resolves vault path from authConfig when settings is absent", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
      config: { authConfig: { vaultPath: testVaultPath } },
    });

    const connectResult = await integration.connect();
    expect(connectResult.ok).toBe(true);
  });

  it("exposes operations from the manifest", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
    });

    const operations = integration.getOperations();
    expect(operations).toHaveLength(6);
    const opNames = operations.map((op) => op.name);
    expect(opNames).toContain("connect");
    expect(opNames).toContain("disconnect");
    expect(opNames).toContain("search-notes");
    expect(opNames).toContain("read-note");
    expect(opNames).toContain("create-note");
    expect(opNames).toContain("list-notes");
  });

  it("reports correct status after connect and disconnect", async () => {
    const vault = new InMemoryCredentialVault();
    const manifestResult = await loadObsidianManifest();
    if (!manifestResult.ok) return;

    const integration = new ObsidianIntegration({
      vault,
      manifest: manifestResult.value,
      config: { settings: { vaultPath: testVaultPath } },
    });

    // Before connect
    const beforeStatus = integration.getStatus();
    expect(beforeStatus.indicator).toBe("disconnected");

    // After connect
    await integration.connect();
    const connectedStatus = integration.getStatus();
    expect(connectedStatus.state).toBe(IntegrationState.CONNECTED);
    expect(connectedStatus.indicator).toBe("connected");

    // After disconnect
    await integration.disconnect();
    const disconnectedStatus = integration.getStatus();
    expect(disconnectedStatus.state).toBe(IntegrationState.DISCONNECTED);
  });
});
