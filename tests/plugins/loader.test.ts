import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

import { InMemoryPermissionAuditLog } from "../../src/plugins/audit";
import { InMemoryPluginEventBus } from "../../src/plugins/events";
import { PluginLifecycleManager } from "../../src/plugins/lifecycle";
import { PluginLoader } from "../../src/plugins/loader";
import { PluginPermissionChecker } from "../../src/plugins/permissions";
import { MockPluginSandbox, type SandboxConfig } from "../../src/plugins/sandbox";
import { InMemoryPluginStateStore } from "../../src/plugins/state";
import type { PluginManifest } from "../../src/types";

function fixturePath(name: string): string {
  return resolve(import.meta.dir, "sandbox", "fixtures", name);
}

function createManifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
  return {
    name: "basic-plugin",
    version: "1.0.0",
    description: "Test plugin",
    author: "Reins",
    permissions: ["read_notes"],
    entryPoint: fixturePath("basic-plugin.ts"),
    ...overrides,
  };
}

function createLoader(stateStore = new InMemoryPluginStateStore()) {
  const lifecycleManager = new PluginLifecycleManager(stateStore);
  const auditLog = new InMemoryPermissionAuditLog();
  const eventBus = new InMemoryPluginEventBus();

  const sandboxFactory = (config: SandboxConfig) =>
    new MockPluginSandbox({
      ...config,
      limits: {
        ...config.limits,
        maxEventHandlerMs: 100,
      },
    });

  const loader = new PluginLoader(
    lifecycleManager,
    sandboxFactory,
    (pluginName, permissions) => new PluginPermissionChecker(pluginName, permissions, auditLog),
    auditLog,
    eventBus,
  );

  return { lifecycleManager, loader, eventBus };
}

describe("PluginLoader", () => {
  it("loadPlugin creates sandbox and starts it", async () => {
    const { lifecycleManager, loader } = createLoader();
    await lifecycleManager.install(createManifest(), fixturePath("basic-plugin.ts"));
    await lifecycleManager.enable("basic-plugin");

    await loader.loadPlugin("basic-plugin");

    expect(loader.isLoaded("basic-plugin")).toBe(true);
    expect(loader.getLoadedPlugins()).toContain("basic-plugin");
  });

  it("loadPlugin registers tools from sandbox", async () => {
    const { lifecycleManager, loader } = createLoader();
    await lifecycleManager.install(createManifest(), fixturePath("basic-plugin.ts"));
    await lifecycleManager.enable("basic-plugin");

    await loader.loadPlugin("basic-plugin");

    expect(loader.getRegisteredTools("basic-plugin")).toContain("echo");
  });

  it("unloadPlugin stops sandbox and removes tools", async () => {
    const { lifecycleManager, loader } = createLoader();
    await lifecycleManager.install(createManifest(), fixturePath("basic-plugin.ts"));
    await lifecycleManager.enable("basic-plugin");
    await loader.loadPlugin("basic-plugin");

    await loader.unloadPlugin("basic-plugin");

    expect(loader.isLoaded("basic-plugin")).toBe(false);
    expect(loader.getRegisteredTools("basic-plugin")).toHaveLength(0);
  });

  it("loadAllEnabled loads all enabled plugins", async () => {
    const { lifecycleManager, loader } = createLoader();

    await lifecycleManager.install(createManifest({ name: "plugin-one" }), fixturePath("basic-plugin.ts"));
    await lifecycleManager.install(createManifest({ name: "plugin-two" }), fixturePath("basic-plugin.ts"));
    await lifecycleManager.enable("plugin-one");
    await lifecycleManager.enable("plugin-two");

    await loader.loadAllEnabled();

    expect(loader.getLoadedPlugins().sort()).toEqual(["plugin-one", "plugin-two"]);
  });

  it("loadPlugin skips disabled plugin", async () => {
    const { lifecycleManager, loader } = createLoader();
    await lifecycleManager.install(createManifest({ name: "disabled-plugin" }), fixturePath("basic-plugin.ts"));

    await loader.loadPlugin("disabled-plugin");

    expect(loader.isLoaded("disabled-plugin")).toBe(false);
  });

  it("plugin crash does not affect other plugins", async () => {
    const { lifecycleManager, loader, eventBus } = createLoader();

    await lifecycleManager.install(
      createManifest({ name: "crash-plugin", entryPoint: fixturePath("crash-plugin.ts") }),
      fixturePath("crash-plugin.ts"),
    );
    await lifecycleManager.install(
      createManifest({ name: "healthy-plugin", entryPoint: fixturePath("basic-plugin.ts") }),
      fixturePath("basic-plugin.ts"),
    );

    await lifecycleManager.enable("crash-plugin");
    await lifecycleManager.enable("healthy-plugin");

    await loader.loadAllEnabled();
    await eventBus.emit("message", { text: "hello" });

    expect(loader.isLoaded("crash-plugin")).toBe(false);
    expect(loader.isLoaded("healthy-plugin")).toBe(true);
  });
});
