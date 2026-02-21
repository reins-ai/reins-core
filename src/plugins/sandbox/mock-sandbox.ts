import type {
  PluginContext,
  PluginEvent,
  PluginEventHandler,
  PluginLogger,
  Tool,
  ToolContext,
  ToolResult,
} from "../../types";
import { createNoOpDataAccess, type PluginDataAccess } from "../api";
import { InMemoryPermissionAuditLog, type PermissionAuditLog } from "../audit";
import { EnforcedDataAccess } from "../enforcement";
import { PluginPermissionChecker } from "../permissions";
import { loadPluginEntrypoint } from "./module-loader";
import { PluginSandbox } from "./sandbox";
import type { SandboxConfig, SerializedToolDefinition } from "./types";

export class MockPluginSandbox extends PluginSandbox {
  private mockRunning = false;
  private readonly eventHandlers = new Map<PluginEvent, Set<PluginEventHandler>>();
  private readonly tools = new Map<string, Tool>();
  private readonly mockRegisteredTools = new Map<string, SerializedToolDefinition>();
  private readonly toolCallbacks: Array<(tool: SerializedToolDefinition) => void> = [];
  private readonly mockErrorCallbacks: Array<(error: Error) => void> = [];

  private mockDataAccess: PluginDataAccess = createNoOpDataAccess();
  private readonly mockAuditLog: PermissionAuditLog;

  constructor(private readonly mockConfig: SandboxConfig, auditLog?: PermissionAuditLog) {
    super(mockConfig, auditLog);
    this.mockAuditLog = auditLog ?? new InMemoryPermissionAuditLog();
  }

  async start(): Promise<void> {
    if (this.mockRunning) {
      return;
    }

    try {
      const pluginEntrypoint = await loadPluginEntrypoint(this.mockConfig.entryPoint, {
        permissions: this.mockConfig.permissions,
      });
      await pluginEntrypoint(this.createContext());
      this.mockRunning = true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.notifyError(err);
      throw err;
    }
  }

  async stop(): Promise<void> {
    this.mockRunning = false;
    this.eventHandlers.clear();
    this.tools.clear();
  }

  async sendEvent(event: PluginEvent, data: unknown): Promise<void> {
    this.assertActive();
    const handlers = this.eventHandlers.get(event);
    if (!handlers) {
      return;
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Event handler timed out after ${this.mockConfig.limits.maxEventHandlerMs}ms`));
      }, this.mockConfig.limits.maxEventHandlerMs);
    });

    const invokePromise = (async () => {
      for (const handler of handlers) {
        await handler(data);
      }
    })();

    try {
      await Promise.race([invokePromise, timeoutPromise]);
    } catch (error) {
      this.mockRunning = false;
      const err = error instanceof Error ? error : new Error(String(error));
      this.notifyError(err);
      throw err;
    }
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    this.assertActive();

    const tool = this.tools.get(toolName);
    if (!tool) {
      throw new Error(`Tool not found: ${toolName}`);
    }

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Tool execution timed out after ${this.mockConfig.limits.maxEventHandlerMs}ms`));
      }, this.mockConfig.limits.maxEventHandlerMs);
    });

    try {
      return await Promise.race([tool.execute(args, context), timeoutPromise]);
    } catch (error) {
      this.mockRunning = false;
      const err = error instanceof Error ? error : new Error(String(error));
      this.notifyError(err);
      throw err;
    }
  }

  getRegisteredTools(): SerializedToolDefinition[] {
    return Array.from(this.mockRegisteredTools.values()).map((tool) => ({ ...tool }));
  }

  isRunning(): boolean {
    return this.mockRunning;
  }

  onToolRegistered(callback: (tool: SerializedToolDefinition) => void): void {
    this.toolCallbacks.push(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.mockErrorCallbacks.push(callback);
  }

  setDataAccess(dataAccess: PluginDataAccess): void {
    this.mockDataAccess = dataAccess;
  }

  getPermissionAuditLog(): PermissionAuditLog {
    return this.mockAuditLog;
  }

  private createContext(): PluginContext {
    const checker = new PluginPermissionChecker(
      this.mockConfig.pluginName,
      this.mockConfig.permissions,
      this.mockAuditLog,
    );
    const enforcedData = new EnforcedDataAccess(this.mockDataAccess, checker);
    const configStore = new Map<string, unknown>();

    const logger: PluginLogger = {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
      debug: () => undefined,
    };

    return {
      registerTool: (tool: Tool) => {
        this.tools.set(tool.definition.name, tool);

        const definition: SerializedToolDefinition = {
          name: tool.definition.name,
          description: tool.definition.description,
          parameters: tool.definition.parameters,
        };

        this.mockRegisteredTools.set(tool.definition.name, definition);
        for (const callback of this.toolCallbacks) {
          callback(definition);
        }
      },
      on: (event: PluginEvent, handler: PluginEventHandler) => {
        const handlers = this.eventHandlers.get(event) ?? new Set<PluginEventHandler>();
        handlers.add(handler);
        this.eventHandlers.set(event, handlers);
      },
      off: (event: PluginEvent, handler: PluginEventHandler) => {
        const handlers = this.eventHandlers.get(event);
        if (!handlers) {
          return;
        }

        handlers.delete(handler);
        if (handlers.size === 0) {
          this.eventHandlers.delete(event);
        }
      },
      data: enforcedData,
      config: {
        get<T>(key: string): T | undefined {
          return configStore.get(key) as T | undefined;
        },
        set<T>(key: string, value: T): void {
          configStore.set(key, value);
        },
      },
      log: logger,
    };
  }

  private assertActive(): void {
    if (!this.mockRunning) {
      throw new Error(`Plugin sandbox is not running for ${this.mockConfig.pluginName}`);
    }
  }

  private notifyError(error: Error): void {
    for (const callback of this.mockErrorCallbacks) {
      callback(error);
    }
  }
}
