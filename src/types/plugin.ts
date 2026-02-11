import type { Tool } from "./tool";
import type { PluginDataAccess } from "../plugins/api";

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  permissions: PluginPermission[];
  entryPoint: string;
  dependencies?: Record<string, string>;
  homepage?: string;
  repository?: string;
  license?: string;
  minReinsVersion?: string;
}

export type PluginPermission =
  | "read_conversations"
  | "write_conversations"
  | "read_calendar"
  | "write_calendar"
  | "read_notes"
  | "write_notes"
  | "read_reminders"
  | "write_reminders"
  | "network_access"
  | "file_access"
  | "schedule_cron"
  | "admin_cron";

export interface PluginContext {
  registerTool(tool: Tool): void;
  on(event: PluginEvent, handler: PluginEventHandler): void;
  off(event: PluginEvent, handler: PluginEventHandler): void;
  data: PluginDataAccess;
  config: PluginConfigAPI;
  log: PluginLogger;
}

export type PluginEvent = "message" | "tool_call" | "conversation_start" | "conversation_end";
export type PluginEventHandler = (data: unknown) => void | Promise<void>;

export interface PluginConfigAPI {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

export interface PluginLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

export type PluginState = "installed" | "enabled" | "disabled" | "error";

export interface PluginInfo {
  manifest: PluginManifest;
  state: PluginState;
  installedAt: Date;
}
