import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";

import { ConversationManager, InMemoryConversationStore } from "../../src/conversation";
import { InMemoryPermissionAuditLog } from "../../src/plugins/audit";
import { InMemoryPluginEventBus } from "../../src/plugins/events";
import { PluginLifecycleManager } from "../../src/plugins/lifecycle";
import { PluginLoader } from "../../src/plugins/loader";
import { validateManifest } from "../../src/plugins/manifest";
import { PluginPermissionChecker } from "../../src/plugins/permissions";
import { MockPluginSandbox, type SandboxConfig } from "../../src/plugins/sandbox";
import { InMemoryPluginStateStore } from "../../src/plugins/state";
import type { PluginManifest } from "../../src/types";

function fixturePath(fileName: string): string {
  return resolve(import.meta.dir, "..", "plugins", "sandbox", "fixtures", fileName);
}

function createManifest(): PluginManifest {
  return {
    name: "journey-plugin",
    version: "1.0.0",
    description: "Plugin used in E2E journey testing",
    author: "Reins",
    permissions: ["read_notes"],
    entryPoint: fixturePath("basic-plugin.ts"),
  };
}

describe("e2e/plugin-journey", () => {
  it("covers plugin validation, install, usage, disable, and uninstall", async () => {
    const manifest = createManifest();
    const validation = validateManifest(manifest);
    expect(validation.valid).toBe(true);

    const stateStore = new InMemoryPluginStateStore();
    const lifecycle = new PluginLifecycleManager(stateStore);
    const auditLog = new InMemoryPermissionAuditLog();
    const eventBus = new InMemoryPluginEventBus();

    const loader = new PluginLoader(
      lifecycle,
      (config: SandboxConfig) =>
        new MockPluginSandbox({
          ...config,
          limits: {
            ...config.limits,
            maxEventHandlerMs: 100,
          },
        }),
      (pluginName, permissions) => new PluginPermissionChecker(pluginName, permissions, auditLog),
      auditLog,
      eventBus,
    );

    const installed = await lifecycle.install(manifest, fixturePath("basic-plugin.ts"));
    expect(installed.state).toBe("installed");

    await lifecycle.enable(manifest.name);
    await loader.loadPlugin(manifest.name);
    expect(loader.getLoadedPlugins()).toContain(manifest.name);
    expect(loader.getRegisteredTools(manifest.name)).toContain("echo");

    const directSandbox = new MockPluginSandbox({
      pluginName: manifest.name,
      entryPoint: fixturePath("basic-plugin.ts"),
      permissions: manifest.permissions,
      limits: {
        maxMemoryMB: 16,
        maxCpuMs: 250,
        maxEventHandlerMs: 100,
      },
      timeout: 1000,
    });
    await directSandbox.start();

    const store = new InMemoryConversationStore();
    const manager = new ConversationManager(store);
    const conversation = await manager.create({
      title: "Plugin journey",
      model: "journey-model",
      provider: "gateway",
    });
    await manager.addMessage(conversation.id, { role: "user", content: "Run the echo tool." });

    const pluginResult = await directSandbox.executeToolCall(
      "echo",
      { text: "hello plugin" },
      {
        conversationId: conversation.id,
        userId: "user-1",
        workspaceId: "ws-1",
      },
    );
    await manager.addMessage(conversation.id, {
      role: "tool",
      content: JSON.stringify(pluginResult.result),
      toolResultId: pluginResult.callId,
    });

    const history = await manager.getHistory(conversation.id);
    expect(history[1]?.role).toBe("tool");
    expect(history[1]?.content).toContain("hello plugin");

    await directSandbox.stop();

    await lifecycle.disable(manifest.name);
    await loader.unloadPlugin(manifest.name);
    expect(loader.getRegisteredTools(manifest.name)).toHaveLength(0);

    await lifecycle.uninstall(manifest.name);
    expect(lifecycle.getPlugin(manifest.name)).toBeUndefined();
  });
});
