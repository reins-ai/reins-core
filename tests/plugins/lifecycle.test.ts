import { describe, expect, it } from "bun:test";

import { PluginError } from "../../src/errors";
import { PluginLifecycleManager } from "../../src/plugins/lifecycle";
import { InMemoryPluginStateStore } from "../../src/plugins/state";
import type { PluginManifest } from "../../src/types";

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "sample-plugin",
    version: "1.0.0",
    description: "A plugin",
    author: "Reins",
    permissions: ["read_notes"],
    entryPoint: "index.ts",
    ...overrides,
  };
}

describe("PluginLifecycleManager", () => {
  it("installs plugin from valid manifest", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());

    const info = await manager.install(createManifest(), "/plugins/sample");

    expect(info.manifest.name).toBe("sample-plugin");
    expect(info.state).toBe("installed");
    expect(manager.getPlugin("sample-plugin")?.state).toBe("installed");
  });

  it("fails to install duplicate plugin", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());

    await manager.install(createManifest(), "/plugins/sample");

    await expect(manager.install(createManifest(), "/plugins/sample")).rejects.toThrow(PluginError);
  });

  it("enables installed plugin", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());
    await manager.install(createManifest(), "/plugins/sample");

    const info = await manager.enable("sample-plugin");

    expect(info.state).toBe("enabled");
  });

  it("fails to enable non-installed plugin", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());

    await expect(manager.enable("missing-plugin")).rejects.toThrow(PluginError);
  });

  it("disables an enabled plugin", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());
    await manager.install(createManifest(), "/plugins/sample");
    await manager.enable("sample-plugin");

    const info = await manager.disable("sample-plugin");

    expect(info.state).toBe("disabled");
  });

  it("fails to disable non-installed plugin", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());

    await expect(manager.disable("missing-plugin")).rejects.toThrow(PluginError);
  });

  it("uninstalls plugin and clears state", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());
    await manager.install(createManifest(), "/plugins/sample");

    await manager.uninstall("sample-plugin");

    expect(manager.getPlugin("sample-plugin")).toBeUndefined();
  });

  it("fails to uninstall non-installed plugin", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());

    await expect(manager.uninstall("missing-plugin")).rejects.toThrow(PluginError);
  });

  it("updates an installed plugin", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());
    await manager.install(createManifest(), "/plugins/sample");

    const info = await manager.update(
      "sample-plugin",
      createManifest({ version: "1.1.0", description: "Updated" }),
      "/plugins/sample-v2",
    );

    expect(info.manifest.version).toBe("1.1.0");
    expect(info.manifest.description).toBe("Updated");
  });

  it("returns all installed plugins", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());
    await manager.install(createManifest({ name: "plugin-a" }), "/plugins/a");
    await manager.install(createManifest({ name: "plugin-b" }), "/plugins/b");

    const plugins = manager.getInstalledPlugins();

    expect(plugins).toHaveLength(2);
    expect(plugins.map((plugin) => plugin.manifest.name).sort()).toEqual(["plugin-a", "plugin-b"]);
  });

  it("returns only enabled plugins", async () => {
    const manager = new PluginLifecycleManager(new InMemoryPluginStateStore());
    await manager.install(createManifest({ name: "plugin-a" }), "/plugins/a");
    await manager.install(createManifest({ name: "plugin-b" }), "/plugins/b");

    await manager.enable("plugin-b");

    const plugins = manager.getEnabledPlugins();

    expect(plugins).toHaveLength(1);
    expect(plugins[0]?.manifest.name).toBe("plugin-b");
  });
});
