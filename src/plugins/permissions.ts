import { PluginError } from "../errors";
import type { PluginPermission } from "../types";
import type { PermissionAuditLog } from "./audit";

const ALL_PLUGIN_PERMISSIONS: PluginPermission[] = [
  "read_conversations",
  "write_conversations",
  "read_calendar",
  "write_calendar",
  "read_notes",
  "write_notes",
  "read_reminders",
  "write_reminders",
  "network_access",
  "file_access",
  "schedule_cron",
  "admin_cron",
];

export const PERMISSION_DESCRIPTIONS: Record<PluginPermission, string> = {
  read_conversations: "Read conversation metadata and message history.",
  write_conversations: "Create or modify conversation data.",
  read_calendar: "Read calendar events.",
  write_calendar: "Create or modify calendar events.",
  read_notes: "Read user notes.",
  write_notes: "Create or modify user notes.",
  read_reminders: "Read reminders.",
  write_reminders: "Create or modify reminders.",
  network_access: "Make outbound network requests.",
  file_access: "Read or write local files.",
  schedule_cron: "Create, update, and delete scheduled cron jobs.",
  admin_cron: "Manage all cron jobs and override scheduling policies.",
};

export interface PermissionChecker {
  hasPermission(permission: PluginPermission): boolean;
  requirePermission(permission: PluginPermission): void;
  getGrantedPermissions(): PluginPermission[];
  getDeniedPermissions(): PluginPermission[];
}

export class PluginPermissionError extends PluginError {
  constructor(
    pluginName: string,
    permission: PluginPermission,
    action: string,
    message = `Plugin ${pluginName} is missing required permission: ${permission}`,
  ) {
    super(message);
    this.name = "PluginPermissionError";
    this.permission = permission;
    this.pluginName = pluginName;
    this.action = action;
  }

  readonly permission: PluginPermission;
  readonly pluginName: string;
  readonly action: string;
}

export class PluginPermissionChecker implements PermissionChecker {
  private readonly grantedPermissionSet: ReadonlySet<PluginPermission>;

  constructor(
    private readonly pluginName: string,
    private readonly grantedPermissions: PluginPermission[],
    private readonly auditLog: PermissionAuditLog,
  ) {
    this.grantedPermissionSet = new Set(grantedPermissions);
  }

  hasPermission(permission: PluginPermission): boolean {
    const granted = this.grantedPermissionSet.has(permission);

    this.auditLog.record({
      timestamp: Date.now(),
      pluginName: this.pluginName,
      permission,
      action: "permission.check",
      granted,
      error: granted ? undefined : this.createDeniedMessage(permission),
    });

    return granted;
  }

  requirePermission(permission: PluginPermission): void {
    this.requirePermissionForAction(permission, "permission.require");
  }

  requirePermissionForAction(permission: PluginPermission, action: string): void {
    const granted = this.grantedPermissionSet.has(permission);

    if (granted) {
      this.auditLog.record({
        timestamp: Date.now(),
        pluginName: this.pluginName,
        permission,
        action,
        granted: true,
      });
      return;
    }

    const error = new PluginPermissionError(
      this.pluginName,
      permission,
      action,
      this.createDeniedMessage(permission),
    );

    this.auditLog.record({
      timestamp: Date.now(),
      pluginName: this.pluginName,
      permission,
      action,
      granted: false,
      error: error.message,
    });

    throw error;
  }

  getGrantedPermissions(): PluginPermission[] {
    return this.grantedPermissions.slice();
  }

  getDeniedPermissions(): PluginPermission[] {
    return ALL_PLUGIN_PERMISSIONS.filter((permission) => !this.grantedPermissionSet.has(permission));
  }

  private createDeniedMessage(permission: PluginPermission): string {
    return `Plugin ${this.pluginName} is missing required permission: ${permission}`;
  }
}

export function enforcePermission(
  checker: PermissionChecker,
  permission: PluginPermission,
  action: string,
): void {
  if (checker instanceof PluginPermissionChecker) {
    checker.requirePermissionForAction(permission, action);
    return;
  }

  checker.requirePermission(permission);
}
