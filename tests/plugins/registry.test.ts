import { describe, expect, it } from "bun:test";

import { InMemoryPluginRegistry, type PluginRegistryEntry } from "../../src/plugins/registry";

function createEntry(overrides: Partial<PluginRegistryEntry> = {}): PluginRegistryEntry {
  return {
    name: "notes-helper",
    version: "1.0.0",
    description: "Helps manage notes",
    author: "Reins",
    permissions: ["read_notes"],
    ...overrides,
  };
}

describe("InMemoryPluginRegistry", () => {
  it("search returns matching entries", async () => {
    const registry = new InMemoryPluginRegistry();
    registry.addEntry(createEntry({ name: "notes-helper" }));
    registry.addEntry(createEntry({ name: "calendar-tools", description: "Calendar helpers" }));

    const results = await registry.search("notes");

    expect(results).toHaveLength(1);
    expect(results[0]?.name).toBe("notes-helper");
  });

  it("search respects limit", async () => {
    const registry = new InMemoryPluginRegistry();
    registry.addEntry(createEntry({ name: "plugin-a" }));
    registry.addEntry(createEntry({ name: "plugin-b" }));

    const results = await registry.search("plugin", { limit: 1 });

    expect(results).toHaveLength(1);
  });

  it("getDetails returns latest entry", async () => {
    const registry = new InMemoryPluginRegistry();
    registry.addEntry(createEntry({ name: "notes-helper", version: "1.0.0" }));
    registry.addEntry(createEntry({ name: "notes-helper", version: "1.2.0" }));

    const details = await registry.getDetails("notes-helper");

    expect(details).not.toBeNull();
    expect(details?.version).toBe("1.2.0");
  });

  it("getDetails returns null for unknown plugin", async () => {
    const registry = new InMemoryPluginRegistry();

    const details = await registry.getDetails("missing-plugin");

    expect(details).toBeNull();
  });

  it("getVersions returns sorted versions", async () => {
    const registry = new InMemoryPluginRegistry();
    registry.addEntry(createEntry({ name: "notes-helper", version: "1.2.0" }));
    registry.addEntry(createEntry({ name: "notes-helper", version: "1.0.0" }));
    registry.addEntry(createEntry({ name: "notes-helper", version: "1.1.0" }));

    const versions = await registry.getVersions("notes-helper");

    expect(versions).toEqual(["1.0.0", "1.1.0", "1.2.0"]);
  });

  it("checkUpdate detects new version", async () => {
    const registry = new InMemoryPluginRegistry();
    registry.addEntry(createEntry({ name: "notes-helper", version: "1.0.0" }));
    registry.addEntry(createEntry({ name: "notes-helper", version: "1.1.0" }));

    const update = await registry.checkUpdate("notes-helper", "1.0.0");

    expect(update).toEqual({ hasUpdate: true, latestVersion: "1.1.0" });
  });

  it("checkUpdate reports up-to-date version", async () => {
    const registry = new InMemoryPluginRegistry();
    registry.addEntry(createEntry({ name: "notes-helper", version: "1.1.0" }));

    const update = await registry.checkUpdate("notes-helper", "1.1.0");

    expect(update).toEqual({ hasUpdate: false });
  });
});
