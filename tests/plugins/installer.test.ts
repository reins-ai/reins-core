import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginError } from "../../src/errors";
import { PluginInstaller } from "../../src/plugins/installer";
import { PluginLifecycleManager } from "../../src/plugins/lifecycle";
import { InMemoryPluginRegistry, type PluginRegistryEntry } from "../../src/plugins/registry";
import { InMemoryPluginStateStore } from "../../src/plugins/state";
import type { PluginManifest } from "../../src/types";

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "notes-helper",
    version: "1.0.0",
    description: "Helps with notes",
    author: "Reins",
    permissions: ["read_notes"],
    entryPoint: "index.ts",
    ...overrides,
  };
}

function createRegistryEntry(overrides: Partial<PluginRegistryEntry> = {}): PluginRegistryEntry {
  return {
    name: "notes-helper",
    version: "1.0.0",
    description: "Helps with notes",
    author: "Reins",
    permissions: ["read_notes"],
    ...overrides,
  };
}

async function createLocalPlugin(dir: string, manifest: PluginManifest): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "reins-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(dir, "index.ts"), "export default async function setup() { return; }\n", "utf8");
}

describe("PluginInstaller", () => {
  it("installs from local path by reading manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-installer-local-"));

    try {
      const sourcePath = join(root, "source-plugin");
      const pluginsDir = join(root, "plugins");
      await createLocalPlugin(sourcePath, createManifest());

      const installer = new PluginInstaller({
        pluginsDir,
        registry: new InMemoryPluginRegistry(),
        lifecycleManager: new PluginLifecycleManager(new InMemoryPluginStateStore()),
      });

      const info = await installer.installFromLocal(sourcePath);

      expect(info.manifest.name).toBe("notes-helper");
      expect(info.state).toBe("installed");

      const copiedManifest = await readFile(join(pluginsDir, "notes-helper", "reins-plugin.json"), "utf8");
      expect(copiedManifest).toContain('"name": "notes-helper"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when local manifest is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-installer-invalid-"));

    try {
      const sourcePath = join(root, "bad-plugin");
      const pluginsDir = join(root, "plugins");
      await createLocalPlugin(sourcePath, createManifest({ permissions: [] }));

      await writeFile(
        join(sourcePath, "reins-plugin.json"),
        JSON.stringify({ ...createManifest(), permissions: ["invalid_permission"] }, null, 2),
        "utf8",
      );

      const installer = new PluginInstaller({
        pluginsDir,
        registry: new InMemoryPluginRegistry(),
        lifecycleManager: new PluginLifecycleManager(new InMemoryPluginStateStore()),
      });

      await expect(installer.installFromLocal(sourcePath)).rejects.toThrow(PluginError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails when installing duplicate plugin", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-installer-duplicate-"));

    try {
      const sourcePath = join(root, "source-plugin");
      const pluginsDir = join(root, "plugins");
      await createLocalPlugin(sourcePath, createManifest());

      const installer = new PluginInstaller({
        pluginsDir,
        registry: new InMemoryPluginRegistry(),
        lifecycleManager: new PluginLifecycleManager(new InMemoryPluginStateStore()),
      });

      await installer.installFromLocal(sourcePath);
      await expect(installer.installFromLocal(sourcePath)).rejects.toThrow(PluginError);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uninstall removes plugin files", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-installer-uninstall-"));

    try {
      const sourcePath = join(root, "source-plugin");
      const pluginsDir = join(root, "plugins");
      await createLocalPlugin(sourcePath, createManifest());

      const lifecycleManager = new PluginLifecycleManager(new InMemoryPluginStateStore());
      const installer = new PluginInstaller({
        pluginsDir,
        registry: new InMemoryPluginRegistry(),
        lifecycleManager,
      });

      await installer.installFromLocal(sourcePath);
      await installer.uninstall("notes-helper");

      expect(lifecycleManager.getPlugin("notes-helper")).toBeUndefined();
      const exists = await Bun.file(join(pluginsDir, "notes-helper", "reins-plugin.json")).exists();
      expect(exists).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("update replaces plugin version", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-installer-update-"));

    try {
      const pluginsDir = join(root, "plugins");
      const registry = new InMemoryPluginRegistry();
      registry.addEntry(createRegistryEntry({ version: "1.0.0" }));
      registry.addEntry(createRegistryEntry({ version: "1.1.0" }));

      const lifecycleManager = new PluginLifecycleManager(new InMemoryPluginStateStore());
      const installer = new PluginInstaller({ pluginsDir, registry, lifecycleManager });

      await installer.installFromNpm("notes-helper", "1.0.0");
      const updated = await installer.update("notes-helper");

      expect(updated.manifest.version).toBe("1.1.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checkUpdates finds available updates", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-installer-check-updates-"));

    try {
      const pluginsDir = join(root, "plugins");
      const registry = new InMemoryPluginRegistry();
      registry.addEntry(createRegistryEntry({ version: "1.0.0" }));
      registry.addEntry(createRegistryEntry({ version: "1.2.0" }));

      const lifecycleManager = new PluginLifecycleManager(new InMemoryPluginStateStore());
      const installer = new PluginInstaller({ pluginsDir, registry, lifecycleManager });

      await installer.installFromNpm("notes-helper", "1.0.0");
      const updates = await installer.checkUpdates();

      expect(updates).toHaveLength(1);
      expect(updates[0]).toEqual({
        pluginName: "notes-helper",
        currentVersion: "1.0.0",
        latestVersion: "1.2.0",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("checkUpdates reports none when all current", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-installer-current-"));

    try {
      const pluginsDir = join(root, "plugins");
      const registry = new InMemoryPluginRegistry();
      registry.addEntry(createRegistryEntry({ version: "1.1.0" }));

      const lifecycleManager = new PluginLifecycleManager(new InMemoryPluginStateStore());
      const installer = new PluginInstaller({ pluginsDir, registry, lifecycleManager });

      await installer.installFromNpm("notes-helper", "1.1.0");
      const updates = await installer.checkUpdates();

      expect(updates).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
