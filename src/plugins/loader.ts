import { isAbsolute, join, resolve } from "node:path";

import { PluginError } from "../errors";
import type { PluginEvent, PluginPermission } from "../types";
import type { PermissionAuditLog } from "./audit";
import type { PluginEventBus } from "./events";
import type { PluginLifecycleManager } from "./lifecycle";
import type { PermissionChecker } from "./permissions";
import { DEFAULT_RESOURCE_LIMITS, type SandboxConfig } from "./sandbox";
import { PluginSandbox } from "./sandbox";

const PLUGIN_EVENTS: PluginEvent[] = [
  "message",
  "tool_call",
  "conversation_start",
  "conversation_end",
];

interface LoadedPlugin {
  sandbox: PluginSandbox;
  tools: Set<string>;
  handlers: Map<PluginEvent, (data: unknown) => Promise<void>>;
}

export class PluginLoader {
  private readonly loaded = new Map<string, LoadedPlugin>();

  constructor(
    private readonly lifecycleManager: PluginLifecycleManager,
    private readonly sandboxFactory: (config: SandboxConfig) => PluginSandbox,
    private readonly permissionChecker: (
      pluginName: string,
      permissions: PluginPermission[],
    ) => PermissionChecker,
    private readonly auditLog: PermissionAuditLog,
    private readonly eventBus: PluginEventBus,
  ) {}

  async loadPlugin(pluginName: string): Promise<void> {
    if (this.loaded.has(pluginName)) {
      return;
    }

    const plugin = this.lifecycleManager.getPlugin(pluginName);
    if (!plugin) {
      throw new PluginError(`Plugin is not installed: ${pluginName}`);
    }

    if (plugin.state !== "enabled") {
      return;
    }

    const checker = this.permissionChecker(pluginName, plugin.manifest.permissions);
    this.recordLoadAuditEntries(pluginName, checker.getGrantedPermissions());

    const sandboxConfig = this.createSandboxConfig(pluginName, plugin.manifest.entryPoint, plugin.manifest.permissions);
    const sandbox = this.sandboxFactory(sandboxConfig);
    const tools = new Set<string>();

    sandbox.onToolRegistered((tool) => {
      tools.add(tool.name);
    });

    sandbox.onError((error) => {
      this.recordLoadAuditEntries(pluginName, checker.getGrantedPermissions(), `sandbox.error:${error.message}`);
      void this.unloadPlugin(pluginName);
    });

    await sandbox.start();
    for (const tool of sandbox.getRegisteredTools()) {
      tools.add(tool.name);
    }

    const handlers = this.registerEventHandlers(pluginName, sandbox, checker);
    this.loaded.set(pluginName, { sandbox, tools, handlers });
  }

  async unloadPlugin(pluginName: string): Promise<void> {
    const loadedPlugin = this.loaded.get(pluginName);
    if (!loadedPlugin) {
      return;
    }

    for (const [event, handler] of loadedPlugin.handlers.entries()) {
      this.eventBus.off(event, pluginName, handler);
    }

    this.eventBus.removeAll(pluginName);
    await loadedPlugin.sandbox.stop();
    this.loaded.delete(pluginName);
  }

  async loadAllEnabled(): Promise<void> {
    const enabled = this.lifecycleManager.getEnabledPlugins();

    for (const plugin of enabled) {
      try {
        await this.loadPlugin(plugin.manifest.name);
      } catch {
        continue;
      }
    }
  }

  getLoadedPlugins(): string[] {
    return Array.from(this.loaded.keys());
  }

  isLoaded(pluginName: string): boolean {
    return this.loaded.has(pluginName);
  }

  getRegisteredTools(pluginName: string): string[] {
    const loadedPlugin = this.loaded.get(pluginName);
    if (!loadedPlugin) {
      return [];
    }

    return Array.from(loadedPlugin.tools.values());
  }

  private registerEventHandlers(
    pluginName: string,
    sandbox: PluginSandbox,
    checker: PermissionChecker,
  ): Map<PluginEvent, (data: unknown) => Promise<void>> {
    const handlers = new Map<PluginEvent, (data: unknown) => Promise<void>>();

    for (const event of PLUGIN_EVENTS) {
      const handler = async (data: unknown): Promise<void> => {
        try {
          await sandbox.sendEvent(event, data);
        } catch {
          this.recordLoadAuditEntries(
            pluginName,
            checker.getGrantedPermissions(),
            `sandbox.event-failure:${event}`,
          );
          await this.unloadPlugin(pluginName);
        }
      };

      handlers.set(event, handler);
      this.eventBus.on(event, pluginName, handler);
    }

    return handlers;
  }

  private createSandboxConfig(
    pluginName: string,
    entryPoint: string,
    permissions: PluginPermission[],
  ): SandboxConfig {
    return {
      pluginName,
      entryPoint: this.resolveEntryPoint(pluginName, entryPoint),
      permissions: [...permissions],
      limits: { ...DEFAULT_RESOURCE_LIMITS },
      timeout: 1_000,
    };
  }

  private resolveEntryPoint(pluginName: string, entryPoint: string): string {
    if (isAbsolute(entryPoint)) {
      return entryPoint;
    }

    return resolve(join("plugins", pluginName, entryPoint));
  }

  private recordLoadAuditEntries(
    pluginName: string,
    permissions: PluginPermission[],
    action = "plugin.load",
  ): void {
    for (const permission of permissions) {
      this.auditLog.record({
        timestamp: Date.now(),
        pluginName,
        permission,
        action,
        granted: true,
      });
    }
  }
}
