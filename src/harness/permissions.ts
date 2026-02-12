import type { ToolCall } from "../types";
import type { TypedEventBus } from "./event-bus";
import { createEventId, type HarnessEventMap } from "./events";

export type PermissionAction = "allow" | "deny" | "ask";
export type PermissionProfileName = "minimal" | "standard" | "full";

export interface PermissionProfile {
  name: PermissionProfileName;
  defaultAction: PermissionAction;
  rules: Record<string, PermissionAction>;
}

export const MINIMAL_PROFILE: PermissionProfile = {
  name: "minimal",
  defaultAction: "deny",
  rules: {
    voice: "allow",
  },
};

export const STANDARD_PROFILE: PermissionProfile = {
  name: "standard",
  defaultAction: "ask",
  rules: {
    notes: "allow",
    reminders: "allow",
    calendar: "allow",
    voice: "allow",
    schedule: "deny",
  },
};

export const FULL_PROFILE: PermissionProfile = {
  name: "full",
  defaultAction: "allow",
  rules: {},
};

export const PERMISSION_PROFILES: Record<PermissionProfileName, PermissionProfile> = {
  minimal: MINIMAL_PROFILE,
  standard: STANDARD_PROFILE,
  full: FULL_PROFILE,
};

export interface PermissionCheckResult {
  action: PermissionAction;
  toolName: string;
  profile: PermissionProfileName;
}

interface PendingPermissionRequest {
  resolve: (granted: boolean) => void;
}

export class PermissionChecker {
  private readonly pendingRequests = new Map<string, PendingPermissionRequest>();

  constructor(
    private readonly profile: PermissionProfile,
    private readonly eventBus?: TypedEventBus<HarnessEventMap>,
  ) {}

  public check(toolCall: ToolCall): PermissionCheckResult {
    const action = this.profile.rules[toolCall.name] ?? this.profile.defaultAction;
    return {
      action,
      toolName: toolCall.name,
      profile: this.profile.name,
    };
  }

  public async requestPermission(toolCall: ToolCall): Promise<boolean> {
    const checkResult = this.check(toolCall);

    if (checkResult.action === "allow") {
      return true;
    }

    if (checkResult.action === "deny") {
      return false;
    }

    if (!this.eventBus) {
      return false;
    }

    const requestId = createEventId("perm");

    return await new Promise<boolean>((resolve) => {
      this.pendingRequests.set(requestId, { resolve });

      void this.eventBus?.emit("permission_request", {
        requestId,
        toolCall,
        profile: this.profile.name,
        reason: `Tool '${toolCall.name}' requires explicit approval under '${this.profile.name}' profile.`,
      });
    });
  }

  public resolvePermission(requestId: string, granted: boolean): void {
    const pendingRequest = this.pendingRequests.get(requestId);
    if (!pendingRequest) {
      return;
    }

    this.pendingRequests.delete(requestId);
    pendingRequest.resolve(granted);
  }
}
