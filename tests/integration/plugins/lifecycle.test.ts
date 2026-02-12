import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginError } from "../../../src/errors";
import { InMemoryPermissionAuditLog } from "../../../src/plugins/audit";
import { InMemoryPluginEventBus } from "../../../src/plugins/events";
import { PluginInstaller } from "../../../src/plugins/installer";
import { PluginLifecycleManager } from "../../../src/plugins/lifecycle";
import { PluginLoader } from "../../../src/plugins/loader";
import { PluginPermissionChecker } from "../../../src/plugins/permissions";
import { InMemoryPluginRegistry } from "../../../src/plugins/registry";
import { DEFAULT_RESOURCE_LIMITS, MockPluginSandbox, type SandboxConfig } from "../../../src/plugins/sandbox";
import { InMemoryPluginStateStore } from "../../../src/plugins/state";
import type { PluginManifest } from "../../../src/types";

declare global {
  var __reinsLifecycleEvents: string[] | undefined;
}

const createdRoots: string[] = [];

afterEach(async () => {
  for (const root of createdRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
  delete globalThis.__reinsLifecycleEvents;
});

function createTestPlugin(overrides: Partial<PluginManifest> = {}): {
  manifest: PluginManifest;
  sourcePath: string;
} {
  return {
    manifest: {
      name: "test-plugin",
      version: "1.0.0",
      description: "Test plugin",
      author: "Test",
      permissions: ["read_notes"],
      entryPoint: "index.ts",
      ...overrides,
    },
    sourcePath: "/tmp/test-plugin",
  };
}

async function createLocalPlugin(
  root: string,
  manifest: PluginManifest,
  sourceCode: string,
): Promise<string> {
  const pluginDir = join(root, manifest.name);
  await mkdir(pluginDir, { recursive: true });
  await writeFile(join(pluginDir, "reins-plugin.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(pluginDir, "index.ts"), sourceCode, "utf8");
  return pluginDir;
}

const lifecyclePluginSource = `
export default async function setupPlugin(context) {
  context.registerTool({
    definition: {
      name: "lifecycle.echo",
      description: "Echo tool for lifecycle integration",
      parameters: {
        type: "object",
        properties: {
          value: { type: "string" }
        },
        required: ["value"]
      }
    },
    async execute(args, toolContext) {
      return {
        callId: toolContext.conversationId,
        name: "lifecycle.echo",
        result: { echoed: args.value }
      };
    }
  });

  context.on("message", async () => {
    const events = globalThis.__reinsLifecycleEvents ?? [];
    events.push("message");
    globalThis.__reinsLifecycleEvents = events;
  });
}
`;

describe("integration/plugins/lifecycle", () => {
  it("covers install/enable/load/disable/re-enable/uninstall flow", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-int-lifecycle-"));
    createdRoots.push(root);
    globalThis.__reinsLifecycleEvents = [];

    const stateStore = new InMemoryPluginStateStore();
    const lifecycleManager = new PluginLifecycleManager(stateStore);
    const auditLog = new InMemoryPermissionAuditLog();
    const eventBus = new InMemoryPluginEventBus();
    const registry = new InMemoryPluginRegistry();
    const pluginsDir = join(root, "installed-plugins");
    const createdSandboxes = new Map<string, MockPluginSandbox>();

    const installer = new PluginInstaller({ pluginsDir, registry, lifecycleManager });
    const loader = new PluginLoader(
      lifecycleManager,
      (config: SandboxConfig) => {
        const sandbox = new MockPluginSandbox(
          {
            ...config,
            limits: {
              ...DEFAULT_RESOURCE_LIMITS,
              maxEventHandlerMs: 100,
            },
          },
          auditLog,
        );
        createdSandboxes.set(config.pluginName, sandbox);
        return sandbox;
      },
      (pluginName, permissions) => new PluginPermissionChecker(pluginName, permissions, auditLog),
      auditLog,
      eventBus,
    );

    const testPlugin = createTestPlugin({ name: "lifecycle-plugin" });
    const sourcePath = await createLocalPlugin(root, testPlugin.manifest, lifecyclePluginSource);

    const installed = await installer.installFromLocal(sourcePath);
    expect(installed.state).toBe("installed");
    expect(lifecycleManager.getPlugin("lifecycle-plugin")?.state).toBe("installed");

    const enabled = await lifecycleManager.enable("lifecycle-plugin");
    expect(enabled.state).toBe("enabled");

    await loader.loadPlugin("lifecycle-plugin");
    expect(loader.isLoaded("lifecycle-plugin")).toBe(true);
    expect(loader.getRegisteredTools("lifecycle-plugin")).toContain("lifecycle.echo");
    expect(createdSandboxes.get("lifecycle-plugin")?.isRunning()).toBe(true);

    await eventBus.emit("message", { text: "first" });
    expect(globalThis.__reinsLifecycleEvents).toEqual(["message"]);

    await lifecycleManager.disable("lifecycle-plugin");
    await loader.unloadPlugin("lifecycle-plugin");
    expect(lifecycleManager.getPlugin("lifecycle-plugin")?.state).toBe("disabled");
    expect(loader.isLoaded("lifecycle-plugin")).toBe(false);
    expect(createdSandboxes.get("lifecycle-plugin")?.isRunning()).toBe(false);

    await lifecycleManager.enable("lifecycle-plugin");
    await loader.loadPlugin("lifecycle-plugin");
    expect(loader.isLoaded("lifecycle-plugin")).toBe(true);

    await eventBus.emit("message", { text: "second" });
    expect(globalThis.__reinsLifecycleEvents).toEqual(["message", "message"]);

    await loader.unloadPlugin("lifecycle-plugin");
    await installer.uninstall("lifecycle-plugin");

    expect(lifecycleManager.getPlugin("lifecycle-plugin")).toBeUndefined();
    expect(loader.isLoaded("lifecycle-plugin")).toBe(false);
    expect(createdSandboxes.get("lifecycle-plugin")?.isRunning()).toBe(false);

    await eventBus.emit("message", { text: "after-uninstall" });
    expect(globalThis.__reinsLifecycleEvents).toEqual(["message", "message"]);
  });

  it("rejects install when manifest is invalid", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-int-lifecycle-invalid-"));
    createdRoots.push(root);

    const stateStore = new InMemoryPluginStateStore();
    const lifecycleManager = new PluginLifecycleManager(stateStore);
    const installer = new PluginInstaller({
      pluginsDir: join(root, "installed-plugins"),
      registry: new InMemoryPluginRegistry(),
      lifecycleManager,
    });

    const pluginDir = join(root, "invalid-plugin");
    await mkdir(pluginDir, { recursive: true });
    await writeFile(
      join(pluginDir, "reins-plugin.json"),
      `${JSON.stringify(
        {
          name: "invalid-plugin",
          version: "1.0.0",
          description: "Invalid plugin",
          author: "Test",
          permissions: ["not_a_valid_permission"],
          entryPoint: "index.ts",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(join(pluginDir, "index.ts"), "export default async function setup() {}\n", "utf8");

    await expect(installer.installFromLocal(pluginDir)).rejects.toThrow(PluginError);
  });

  it("updates an installed plugin version", async () => {
    const root = await mkdtemp(join(tmpdir(), "reins-int-lifecycle-update-"));
    createdRoots.push(root);

    const registry = new InMemoryPluginRegistry();
    registry.addEntry({
      name: "versioned-plugin",
      version: "1.0.0",
      description: "Versioned plugin",
      author: "Test",
      permissions: ["read_notes"],
    });
    registry.addEntry({
      name: "versioned-plugin",
      version: "1.1.0",
      description: "Versioned plugin",
      author: "Test",
      permissions: ["read_notes"],
    });

    const lifecycleManager = new PluginLifecycleManager(new InMemoryPluginStateStore());
    const installer = new PluginInstaller({
      pluginsDir: join(root, "installed-plugins"),
      registry,
      lifecycleManager,
    });

    await installer.installFromNpm("versioned-plugin", "1.0.0");
    const updated = await installer.update("versioned-plugin");

    expect(updated.manifest.version).toBe("1.1.0");
    expect(lifecycleManager.getPlugin("versioned-plugin")?.manifest.version).toBe("1.1.0");
  });
});
