import type { PluginEvent, PluginPermission, ToolContext, ToolResult } from "../../types";

export interface SandboxConfig {
  pluginName: string;
  entryPoint: string;
  permissions: PluginPermission[];
  limits: ResourceLimits;
  timeout: number;
}

export interface ResourceLimits {
  maxMemoryMB: number;
  maxCpuTimeMs: number;
  maxEventHandlerMs: number;
}

export const DEFAULT_RESOURCE_LIMITS: ResourceLimits = {
  maxMemoryMB: 64,
  maxCpuTimeMs: 5000,
  maxEventHandlerMs: 3000,
};

export interface SerializedToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export type HostToWorkerMessage =
  | { type: "init"; config: SandboxConfig }
  | { type: "event"; requestId: string; event: PluginEvent; data: unknown }
  | { type: "tool-call"; requestId: string; toolName: string; args: Record<string, unknown>; context: ToolContext }
  | { type: "api-response"; requestId: string; result: unknown; error?: string }
  | { type: "shutdown" };

export type WorkerToHostMessage =
  | { type: "ready" }
  | { type: "register-tool"; tool: SerializedToolDefinition }
  | { type: "api-request"; requestId: string; method: string; args: unknown[] }
  | { type: "tool-result"; requestId: string; result: ToolResult; error?: string }
  | { type: "log"; level: string; message: string; args: unknown[] }
  | { type: "error"; error: string }
  | { type: "event-handled"; requestId: string; event: PluginEvent; error?: string };
