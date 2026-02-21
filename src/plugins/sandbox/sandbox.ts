import { Worker } from "node:worker_threads";

import { createLogger } from "../../logger";
import type { PluginEvent, ToolContext, ToolResult } from "../../types";

const log = createLogger("plugins:sandbox");

/** Grace period (ms) for the worker to exit cleanly before force-terminating. */
const SANDBOX_STOP_GRACE_MS = 100;
/** Hard deadline (ms) for the terminate() call to complete. */
const SANDBOX_TERMINATE_TIMEOUT_MS = 500;

import { createNoOpDataAccess, type PluginDataAccess } from "../api";
import { InMemoryPermissionAuditLog, type PermissionAuditLog } from "../audit";
import { EnforcedDataAccess } from "../enforcement";
import { PluginPermissionChecker } from "../permissions";
import type {
  HostToWorkerMessage,
  SandboxConfig,
  SerializedToolDefinition,
  WorkerToHostMessage,
} from "./types";

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class PluginSandbox {
  private worker: Worker | null = null;
  private running = false;
  private requestCounter = 0;
  private cpuLimitTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly registeredTools = new Map<string, SerializedToolDefinition>();
  private readonly pendingEvents = new Map<string, PendingRequest<void>>();
  private readonly pendingToolCalls = new Map<string, PendingRequest<ToolResult>>();

  private readonly toolRegisteredCallbacks: Array<(tool: SerializedToolDefinition) => void> = [];
  private readonly errorCallbacks: Array<(error: Error) => void> = [];
  private readonly logs: Array<{ level: string; message: string; args: unknown[] }> = [];

  private dataAccess: PluginDataAccess = createNoOpDataAccess();
  private readonly auditLog: PermissionAuditLog;

  constructor(protected readonly config: SandboxConfig, auditLog?: PermissionAuditLog) {
    this.auditLog = auditLog ?? new InMemoryPermissionAuditLog();
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.worker = new Worker(new URL("./worker-entry.ts", import.meta.url).href, {
      resourceLimits: {
        maxOldGenerationSizeMb: this.config.limits.maxMemoryMB,
      },
    });

    const readyPromise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) {
          return;
        }

        settled = true;
        reject(new Error(`Plugin sandbox did not become ready within ${this.config.timeout}ms`));
      }, this.config.timeout);

      const finalize = (): void => {
        clearTimeout(timeout);
        this.worker?.off("message", handleMessage);
        this.worker?.off("exit", handleExitBeforeReady);
      };

      const handleMessage = (rawMessage: unknown) => {
        const message = rawMessage as WorkerToHostMessage;
        if (message.type === "ready") {
          if (settled) {
            return;
          }

          settled = true;
          finalize();
          resolve();
          return;
        }

        if (message.type === "error") {
          if (settled) {
            return;
          }

          settled = true;
          finalize();
          reject(new Error(message.error));
        }
      };

      const handleExitBeforeReady = (code: number) => {
        if (settled) {
          return;
        }

        settled = true;
        finalize();
        reject(new Error(`Plugin worker exited before ready with code ${code}`));
      };

      this.worker?.on("message", handleMessage);
      this.worker?.on("exit", handleExitBeforeReady);
    });

    this.worker.on("message", (rawMessage: unknown) => {
      void this.handleWorkerMessage(rawMessage as WorkerToHostMessage);
    });

    this.worker.on("error", (error) => {
      this.handleWorkerFailure(error instanceof Error ? error : new Error(String(error)));
    });

    this.worker.on("exit", (code) => {
      if (this.running && code !== 0) {
        this.handleWorkerFailure(new Error(`Plugin worker exited with code ${code}`));
      }
    });

    this.running = true;
    this.postToWorker({
      type: "init",
      config: this.config,
    });

    this.startCpuWatchdog();
    await readyPromise;
  }

  async stop(): Promise<void> {
    if (!this.worker) {
      this.running = false;
      return;
    }

    const worker = this.worker;

    try {
      try {
        worker.postMessage({ type: "shutdown" } satisfies HostToWorkerMessage);
      } catch (e) {
        // Expected: worker may already be terminated — continue with cleanup
        log.debug("failed to send shutdown message to worker", { error: e instanceof Error ? e.message : String(e) });
      }

      await Promise.race([
        new Promise<void>((resolve) => {
          worker.once("exit", () => {
            resolve();
          });
        }),
        new Promise<void>((resolve) => {
          setTimeout(resolve, SANDBOX_STOP_GRACE_MS);
        }),
      ]);
    } finally {
      await Promise.race([
        worker
          .terminate()
          .then(() => undefined)
          .catch(() => undefined),
        new Promise<void>((resolve) => {
          setTimeout(resolve, SANDBOX_TERMINATE_TIMEOUT_MS);
        }),
      ]);
      this.cleanupAfterStop();
    }
  }

  async sendEvent(event: PluginEvent, data: unknown): Promise<void> {
    this.assertRunning();
    const requestId = this.nextRequestId("event");

    const eventPromise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Event handler timed out after ${this.config.limits.maxEventHandlerMs}ms`));
      }, this.config.limits.maxEventHandlerMs);

      this.pendingEvents.set(requestId, { resolve, reject, timeout });
    });

    this.postToWorker({
      type: "event",
      requestId,
      event,
      data,
    });

    try {
      await eventPromise;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async executeToolCall(
    toolName: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    this.assertRunning();
    const requestId = this.nextRequestId("tool");

    const toolPromise = new Promise<ToolResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Tool execution timed out after ${this.config.limits.maxEventHandlerMs}ms`));
      }, this.config.limits.maxEventHandlerMs);

      this.pendingToolCalls.set(requestId, { resolve, reject, timeout });
    });

    this.postToWorker({
      type: "tool-call",
      requestId,
      toolName,
      args,
      context,
    });

    try {
      return await toolPromise;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  getRegisteredTools(): SerializedToolDefinition[] {
    return Array.from(this.registeredTools.values()).map((tool) => ({ ...tool }));
  }

  isRunning(): boolean {
    return this.running;
  }

  onToolRegistered(callback: (tool: SerializedToolDefinition) => void): void {
    this.toolRegisteredCallbacks.push(callback);
  }

  onError(callback: (error: Error) => void): void {
    this.errorCallbacks.push(callback);
  }

  setDataAccess(dataAccess: PluginDataAccess): void {
    this.dataAccess = dataAccess;
  }

  getPermissionAuditLog(): PermissionAuditLog {
    return this.auditLog;
  }

  getLogs(): Array<{ level: string; message: string; args: unknown[] }> {
    return this.logs.map((entry) => ({ ...entry, args: [...entry.args] }));
  }

  protected emitError(error: Error): void {
    for (const callback of this.errorCallbacks) {
      callback(error);
    }
  }

  protected emitToolRegistered(tool: SerializedToolDefinition): void {
    for (const callback of this.toolRegisteredCallbacks) {
      callback(tool);
    }
  }

  private startCpuWatchdog(): void {
    this.clearCpuWatchdog();
    this.cpuLimitTimer = setTimeout(() => {
      void this.stop();
      this.emitError(new Error(`Plugin exceeded CPU time limit of ${this.config.limits.maxCpuTimeMs}ms`));
    }, this.config.limits.maxCpuTimeMs);
  }

  private clearCpuWatchdog(): void {
    if (!this.cpuLimitTimer) {
      return;
    }

    clearTimeout(this.cpuLimitTimer);
    this.cpuLimitTimer = null;
  }

  private nextRequestId(prefix: string): string {
    this.requestCounter += 1;
    return `${prefix}-${this.requestCounter}`;
  }

  private postToWorker(message: HostToWorkerMessage): void {
    if (!this.worker) {
      throw new Error("Plugin sandbox worker is not available");
    }

    this.worker.postMessage(message);
  }

  private assertRunning(): void {
    if (!this.running || !this.worker) {
      throw new Error(`Plugin sandbox is not running for ${this.config.pluginName}`);
    }
  }

  private cleanupAfterStop(): void {
    this.running = false;
    this.worker = null;
    this.clearCpuWatchdog();

    for (const pending of this.pendingEvents.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Plugin sandbox stopped before event completed"));
    }

    for (const pending of this.pendingToolCalls.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Plugin sandbox stopped before tool execution completed"));
    }

    this.pendingEvents.clear();
    this.pendingToolCalls.clear();
  }

  private handleWorkerFailure(error: Error): void {
    this.emitError(error);
    void this.stop();
  }

  private async handleWorkerMessage(message: WorkerToHostMessage): Promise<void> {
    switch (message.type) {
      case "ready": {
        return;
      }
      case "register-tool": {
        this.registeredTools.set(message.tool.name, { ...message.tool });
        this.emitToolRegistered(message.tool);
        return;
      }
      case "api-request": {
        const response = await this.executeApiRequest(message.method, message.args);
        this.postToWorker({
          type: "api-response",
          requestId: message.requestId,
          result: response.result,
          error: response.error,
        });
        return;
      }
      case "event-handled": {
        const pending = this.pendingEvents.get(message.requestId);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingEvents.delete(message.requestId);

        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve();
        }

        return;
      }
      case "tool-result": {
        const pending = this.pendingToolCalls.get(message.requestId);
        if (!pending) {
          return;
        }

        clearTimeout(pending.timeout);
        this.pendingToolCalls.delete(message.requestId);

        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.result);
        }

        return;
      }
      case "error": {
        this.emitError(new Error(message.error));
        return;
      }
      case "log": {
        this.logs.push({
          level: message.level,
          message: message.message,
          args: [...message.args],
        });
        return;
      }
      default: {
        const exhaustiveCheck: never = message;
        throw new Error(`Unhandled worker message type: ${String(exhaustiveCheck)}`);
      }
    }
  }

  private async executeApiRequest(
    method: string,
    args: unknown[],
  ): Promise<{ result: unknown; error?: string }> {
    const checker = new PluginPermissionChecker(
      this.config.pluginName,
      this.config.permissions,
      this.auditLog,
    );
    const enforcedDataAccess = new EnforcedDataAccess(this.dataAccess, checker);

    try {
      const result = await this.callDataMethod(enforcedDataAccess, method, args);
      return { result };
    } catch (error) {
      return {
        result: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async callDataMethod(dataAccess: PluginDataAccess, method: string, args: unknown[]): Promise<unknown> {
    const [scope, operation] = method.split(".");

    if (!scope || !operation) {
      throw new Error(`Invalid API method: ${method}`);
    }

    switch (scope) {
      case "conversations": {
        if (operation === "list") {
          const params = (args[0] as { limit?: number }) ?? {};
          return dataAccess.conversations.list(params);
        }
        if (operation === "getMessages") {
          const conversationId = args[0] as string;
          const params = (args[1] as { limit?: number }) ?? {};
          return dataAccess.conversations.getMessages(conversationId, params);
        }
        break;
      }
      case "calendar": {
        if (operation === "list") {
          const params = (args[0] as { limit?: number }) ?? {};
          return dataAccess.calendar.list(params);
        }
        if (operation === "create") {
          const input = args[0] as { title: string; startAt: Date; endAt: Date };
          return dataAccess.calendar.create(input);
        }
        break;
      }
      case "notes": {
        if (operation === "list") {
          const params = (args[0] as { limit?: number }) ?? {};
          return dataAccess.notes.list(params);
        }
        if (operation === "create") {
          const input = args[0] as { title: string; content: string };
          return dataAccess.notes.create(input);
        }
        break;
      }
      case "reminders": {
        if (operation === "list") {
          const params = (args[0] as { limit?: number }) ?? {};
          return dataAccess.reminders.list(params);
        }
        if (operation === "create") {
          const input = args[0] as { title: string; dueAt: Date };
          return dataAccess.reminders.create(input);
        }
        break;
      }
      default:
        break;
    }

    throw new Error(`Unsupported API method: ${method}`);
  }
}
