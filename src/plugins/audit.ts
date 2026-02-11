import type { PluginPermission } from "../types";
export type { CronAuditEntry, CronAuditEventType, CronAuditLog } from "../cron/executor";
export { InMemoryCronAuditLog } from "../cron/executor";

export interface PermissionAuditEntry {
  timestamp: number;
  pluginName: string;
  permission: PluginPermission;
  action: string;
  granted: boolean;
  error?: string;
}

export interface PermissionAuditLog {
  record(entry: PermissionAuditEntry): void;
  getEntries(pluginName?: string): PermissionAuditEntry[];
  clear(): void;
}

export class InMemoryPermissionAuditLog implements PermissionAuditLog {
  private readonly entries: PermissionAuditEntry[] = [];

  record(entry: PermissionAuditEntry): void {
    this.entries.push({ ...entry });
  }

  getEntries(pluginName?: string): PermissionAuditEntry[] {
    if (!pluginName) {
      return this.entries.map((entry) => ({ ...entry }));
    }

    return this.entries
      .filter((entry) => entry.pluginName === pluginName)
      .map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.entries.length = 0;
  }
}
