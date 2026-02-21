import { parentPort } from "node:worker_threads";

import { createLogger } from "../../logger";
import type {
  PluginContext,
  PluginEvent,
  PluginEventHandler,
  PluginLogger,
  Tool,
  ToolContext,
  ToolResult,
} from "../../types";
import type { PluginDataAccess } from "../api";
import { loadPluginEntrypoint } from "./module-loader";
import type { HostToWorkerMessage, SandboxConfig, WorkerToHostMessage } from "./types";

const log = createLogger("plugins:worker-entry");

if (!parentPort) {
  throw new Error("Plugin sandbox worker must run with a parentPort");
}

const workerPort = parentPort;

const eventHandlers = new Map<PluginEvent, Set<PluginEventHandler>>();
const tools = new Map<string, Tool>();
const pendingApiResponses = new Map<
  string,
  {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }
>();
const pluginConfig = new Map<string, unknown>();

let activeConfig: SandboxConfig | null = null;
const nativeFetch = globalThis.fetch?.bind(globalThis);

function denyProcessEnvAccess(): void {
  const deniedEnv = new Proxy<Record<string, never>>(
    {},
    {
      get() {
        throw new Error("Access to process.env is denied in plugin sandbox");
      },
      set() {
        throw new Error("Access to process.env is denied in plugin sandbox");
      },
      ownKeys() {
        return [];
      },
      getOwnPropertyDescriptor() {
        return {
          configurable: false,
          enumerable: false,
        };
      },
    },
  );

  try {
    Object.defineProperty(process, "env", {
      configurable: false,
      enumerable: false,
      get() {
        return deniedEnv;
      },
      set() {
        throw new Error("Access to process.env is denied in plugin sandbox");
      },
    });
  } catch (e) {
    // Expected: process.env may be non-configurable in some runtimes
    log.debug("failed to deny process.env access", { error: e instanceof Error ? e.message : String(e) });
  }
}

function applyRuntimeGuards(config: SandboxConfig): void {
  denyProcessEnvAccess();

  const hasNetworkAccess = config.permissions.includes("network_access");
  if (nativeFetch) {
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      if (!hasNetworkAccess) {
        throw new Error("Network access is denied in plugin sandbox");
      }

      return nativeFetch(input, init);
    }) as typeof fetch;
  }
}

const logger: PluginLogger = {
  info(message: string, ...args: unknown[]): void {
    post({ type: "log", level: "info", message, args });
  },
  warn(message: string, ...args: unknown[]): void {
    post({ type: "log", level: "warn", message, args });
  },
  error(message: string, ...args: unknown[]): void {
    post({ type: "log", level: "error", message, args });
  },
  debug(message: string, ...args: unknown[]): void {
    post({ type: "log", level: "debug", message, args });
  },
};

const dataApiProxy: PluginDataAccess = {
  conversations: {
    list: async (params) => requestApi("conversations.list", [params]),
    getMessages: async (conversationId, params) =>
      requestApi("conversations.getMessages", [conversationId, params]),
  },
  calendar: {
    list: async (params) => requestApi("calendar.list", [params]),
    create: async (input) => requestApi("calendar.create", [input]),
  },
  notes: {
    list: async (params) => requestApi("notes.list", [params]),
    create: async (input) => requestApi("notes.create", [input]),
  },
  reminders: {
    list: async (params) => requestApi("reminders.list", [params]),
    create: async (input) => requestApi("reminders.create", [input]),
  },
};

const pluginContext: PluginContext = {
  registerTool(tool: Tool): void {
    tools.set(tool.definition.name, tool);
    post({
      type: "register-tool",
      tool: {
        name: tool.definition.name,
        description: tool.definition.description,
        parameters: tool.definition.parameters,
      },
    });
  },
  on(event: PluginEvent, handler: PluginEventHandler): void {
    const handlers = eventHandlers.get(event) ?? new Set<PluginEventHandler>();
    handlers.add(handler);
    eventHandlers.set(event, handlers);
  },
  off(event: PluginEvent, handler: PluginEventHandler): void {
    const handlers = eventHandlers.get(event);
    if (!handlers) {
      return;
    }

    handlers.delete(handler);
    if (handlers.size === 0) {
      eventHandlers.delete(event);
    }
  },
  data: dataApiProxy,
  config: {
    get<T>(key: string): T | undefined {
      return pluginConfig.get(key) as T | undefined;
    },
    set<T>(key: string, value: T): void {
      pluginConfig.set(key, value);
    },
  },
  log: logger,
};

workerPort.on("message", (rawMessage: unknown) => {
  void handleHostMessage(rawMessage as HostToWorkerMessage);
});

async function handleHostMessage(message: HostToWorkerMessage): Promise<void> {
  switch (message.type) {
    case "init": {
      activeConfig = message.config;
      await initializePlugin(message.config);
      post({ type: "ready" });
      return;
    }
    case "event": {
      await invokeEventHandlers(message.requestId, message.event, message.data);
      return;
    }
    case "tool-call": {
      await invokeTool(message.requestId, message.toolName, message.args, message.context);
      return;
    }
    case "api-response": {
      const pending = pendingApiResponses.get(message.requestId);
      if (!pending) {
        return;
      }

      pendingApiResponses.delete(message.requestId);
      if (message.error) {
        pending.reject(new Error(message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    case "shutdown": {
      process.exit(0);
      return;
    }
    default: {
      const exhaustiveCheck: never = message;
      throw new Error(`Unhandled host message type: ${String(exhaustiveCheck)}`);
    }
  }
}

async function initializePlugin(config: SandboxConfig): Promise<void> {
  try {
    applyRuntimeGuards(config);
    const entrypoint = await loadPluginEntrypoint(config.entryPoint, {
      permissions: config.permissions,
    });
    await entrypoint(pluginContext);
  } catch (error) {
    post({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

async function invokeEventHandlers(requestId: string, event: PluginEvent, data: unknown): Promise<void> {
  const handlers = eventHandlers.get(event);
  if (!handlers || handlers.size === 0) {
    post({ type: "event-handled", requestId, event });
    return;
  }

  try {
    for (const handler of handlers) {
      await handler(data);
    }
    post({ type: "event-handled", requestId, event });
  } catch (error) {
    post({
      type: "event-handled",
      requestId,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function invokeTool(
  requestId: string,
  toolName: string,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<void> {
  const tool = tools.get(toolName);
  if (!tool) {
    post({
      type: "tool-result",
      requestId,
      result: {
        callId: requestId,
        name: toolName,
        result: null,
        error: `Tool not found: ${toolName}`,
      },
      error: `Tool not found: ${toolName}`,
    });
    return;
  }

  try {
    const result = await tool.execute(args, context);
    post({
      type: "tool-result",
      requestId,
      result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallbackResult: ToolResult = {
      callId: requestId,
      name: toolName,
      result: null,
      error: message,
    };
    post({
      type: "tool-result",
      requestId,
      result: fallbackResult,
      error: message,
    });
  }
}

function requestApi<T>(method: string, args: unknown[]): Promise<T> {
  const requestId = `api-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  post({
    type: "api-request",
    requestId,
    method,
    args,
  });

  return new Promise<T>((resolve, reject) => {
    pendingApiResponses.set(requestId, {
      resolve: (result: unknown) => {
        resolve(result as T);
      },
      reject,
    });
  });
}

function post(message: WorkerToHostMessage): void {
  workerPort.postMessage(message);
}

if (!activeConfig) {
  logger.debug("Sandbox worker initialized and awaiting config");
}
