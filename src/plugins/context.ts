import type {
  PluginConfigAPI,
  PluginContext,
  PluginEvent,
  PluginEventHandler,
  PluginLogger,
  PluginPermission,
  Tool,
} from "../types";
import { PluginError } from "../errors";
import type { PluginDataAccess } from "./api";
import type { PermissionAuditLog } from "./audit";
import { InMemoryPermissionAuditLog } from "./audit";
import { EnforcedDataAccess } from "./enforcement";
import type { PluginEventBus } from "./events";
import { PluginPermissionChecker } from "./permissions";

export interface PluginToolRegistry {
  register(pluginName: string, tool: Tool): void;
  removeAll(pluginName: string): void;
  list(pluginName?: string): Tool[];
}

export interface PluginConfigStore {
  get<T>(pluginName: string, key: string): T | undefined;
  set<T>(pluginName: string, key: string, value: T): void;
  clear(pluginName: string): void;
}

export class InMemoryPluginToolRegistry implements PluginToolRegistry {
  private readonly toolsByPlugin = new Map<string, Map<string, Tool>>();

  register(pluginName: string, tool: Tool): void {
    const pluginTools = this.toolsByPlugin.get(pluginName) ?? new Map<string, Tool>();
    const toolName = tool.definition.name;

    if (pluginTools.has(toolName)) {
      throw new PluginError(`Tool already registered for plugin ${pluginName}: ${toolName}`);
    }

    pluginTools.set(toolName, tool);
    this.toolsByPlugin.set(pluginName, pluginTools);
  }

  removeAll(pluginName: string): void {
    this.toolsByPlugin.delete(pluginName);
  }

  list(pluginName?: string): Tool[] {
    if (pluginName) {
      return Array.from(this.toolsByPlugin.get(pluginName)?.values() ?? []);
    }

    return Array.from(this.toolsByPlugin.values()).flatMap((tools) => Array.from(tools.values()));
  }
}

export class InMemoryPluginConfigStore implements PluginConfigStore {
  private readonly configByPlugin = new Map<string, Map<string, unknown>>();

  get<T>(pluginName: string, key: string): T | undefined {
    const pluginConfig = this.configByPlugin.get(pluginName);
    if (!pluginConfig || !pluginConfig.has(key)) {
      return undefined;
    }

    return structuredClone(pluginConfig.get(key) as T);
  }

  set<T>(pluginName: string, key: string, value: T): void {
    const pluginConfig = this.configByPlugin.get(pluginName) ?? new Map<string, unknown>();
    pluginConfig.set(key, structuredClone(value));
    this.configByPlugin.set(pluginName, pluginConfig);
  }

  clear(pluginName: string): void {
    this.configByPlugin.delete(pluginName);
  }
}

export class PluginContextImpl implements PluginContext {
  private readonly scopedDataAccess: PluginDataAccess;
  private readonly configApi: PluginConfigAPI;

  constructor(
    private readonly pluginName: string,
    permissions: PluginPermission[],
    private readonly eventBus: PluginEventBus,
    private readonly toolRegistry: PluginToolRegistry,
    dataAccess: PluginDataAccess,
    configStore: PluginConfigStore,
    private readonly logger: PluginLogger,
    permissionAuditLog?: PermissionAuditLog,
  ) {
    const checker = new PluginPermissionChecker(
      pluginName,
      permissions,
      permissionAuditLog ?? new InMemoryPermissionAuditLog(),
    );
    this.scopedDataAccess = new EnforcedDataAccess(dataAccess, checker);
    this.configApi = new PluginConfigApiImpl(pluginName, configStore);
  }

  registerTool(tool: Tool): void {
    const namespacedTool = this.namespaceTool(tool);
    this.toolRegistry.register(this.pluginName, namespacedTool);
  }

  on(event: PluginEvent, handler: PluginEventHandler): void {
    this.eventBus.on(event, this.pluginName, handler);
  }

  off(event: PluginEvent, handler: PluginEventHandler): void {
    this.eventBus.off(event, this.pluginName, handler);
  }

  get data(): PluginDataAccess {
    return this.scopedDataAccess;
  }

  get config(): PluginConfigAPI {
    return this.configApi;
  }

  get log(): PluginLogger {
    return this.logger;
  }

  private namespaceTool(tool: Tool): Tool {
    const originalName = tool.definition.name;
    const prefixedName = originalName.startsWith(`${this.pluginName}.`)
      ? originalName
      : `${this.pluginName}.${originalName}`;

    return {
      ...tool,
      definition: {
        ...tool.definition,
        name: prefixedName,
      },
    };
  }
}

class PluginConfigApiImpl implements PluginConfigAPI {
  constructor(
    private readonly pluginName: string,
    private readonly store: PluginConfigStore,
  ) {}

  get<T>(key: string): T | undefined {
    return this.store.get<T>(this.pluginName, key);
  }

  set<T>(key: string, value: T): void {
    this.store.set(this.pluginName, key, value);
  }
}
