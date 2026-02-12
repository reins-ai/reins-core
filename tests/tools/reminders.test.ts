import { describe, expect, it } from "bun:test";

import { RemindersTool, ToolRegistry, type ReminderBackendClient, type ReminderData } from "../../src/tools";
import type { ToolContext } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-123",
  userId: "user-123",
  workspaceId: "ws-123",
};

describe("RemindersTool", () => {
  it("registers in ToolRegistry and exposes definition", () => {
    const tool = new RemindersTool(createMockBackendClient());
    const registry = new ToolRegistry();

    registry.register(tool);

    const definition = registry.getDefinitions()[0];
    expect(definition?.name).toBe("reminders");
    expect(definition?.parameters.required).toEqual(["action"]);
  });

  it("creates reminders using natural language due time", async () => {
    let capturedDueAt: string | undefined;
    const tool = new RemindersTool(
      createMockBackendClient({
        async createReminder(params) {
          capturedDueAt = params.dueAt;
          return {
            id: "rem-1",
            title: params.title,
            dueAt: params.dueAt,
            priority: params.priority,
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-create",
        action: "create_reminder",
        title: "Call Mom",
        dueAt: "in 30 minutes",
        priority: "high",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; reminder: ReminderData };
    expect(payload.action).toBe("create_reminder");
    expect(payload.reminder.title).toBe("Call Mom");
    expect(payload.reminder.priority).toBe("high");
    expect(capturedDueAt).toBeDefined();
    expect(Date.parse(capturedDueAt as string)).not.toBeNaN();
  });

  it("lists reminders with optional filters", async () => {
    let capturedStatus: string | undefined;
    let capturedPriority: string | undefined;
    let capturedLimit: number | undefined;

    const tool = new RemindersTool(
      createMockBackendClient({
        async listReminders(params) {
          capturedStatus = params.status;
          capturedPriority = params.priority;
          capturedLimit = params.limit;
          return [{ id: "rem-1", title: "Pay rent", dueAt: new Date().toISOString() }];
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-list",
        action: "list_reminders",
        status: "pending",
        priority: "medium",
        limit: 5,
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; reminders: ReminderData[]; count: number };
    expect(payload.action).toBe("list_reminders");
    expect(payload.count).toBe(1);
    expect(capturedStatus).toBe("pending");
    expect(capturedPriority).toBe("medium");
    expect(capturedLimit).toBe(5);
  });

  it("snoozes reminders with default minutes", async () => {
    let capturedId: string | undefined;
    let capturedMinutes: number | undefined;

    const tool = new RemindersTool(
      createMockBackendClient({
        async snoozeReminder(id, minutes) {
          capturedId = id;
          capturedMinutes = minutes;
          return {
            id,
            title: "Reminder",
            dueAt: new Date(Date.now() + minutes * 60_000).toISOString(),
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-snooze",
        action: "snooze_reminder",
        reminderId: "rem-42",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedId).toBe("rem-42");
    expect(capturedMinutes).toBe(15);
  });

  it("dismisses reminders", async () => {
    let dismissedId: string | undefined;

    const tool = new RemindersTool(
      createMockBackendClient({
        async dismissReminder(id) {
          dismissedId = id;
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-dismiss",
        action: "dismiss_reminder",
        reminderId: "rem-5",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(dismissedId).toBe("rem-5");
    expect(result.result).toEqual({ action: "dismiss_reminder", reminderId: "rem-5", success: true });
  });

  it("completes reminders", async () => {
    let completedId: string | undefined;

    const tool = new RemindersTool(
      createMockBackendClient({
        async completeReminder(id) {
          completedId = id;
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-complete",
        action: "complete_reminder",
        reminderId: "rem-9",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(completedId).toBe("rem-9");
    expect(result.result).toEqual({ action: "complete_reminder", reminderId: "rem-9", success: true });
  });

  it("returns validation errors for invalid arguments", async () => {
    const tool = new RemindersTool(createMockBackendClient());

    const missingAction = await tool.execute({}, toolContext);
    expect(missingAction.error).toBe("Missing or invalid 'action' argument.");

    const missingTitle = await tool.execute(
      {
        action: "create",
        dueAt: "in 10 minutes",
      },
      toolContext,
    );
    expect(missingTitle.error).toBe("'title' is required for create action.");

    const invalidDueAt = await tool.execute(
      {
        action: "create",
        title: "Call Mom",
        dueAt: "sometime soon",
      },
      toolContext,
    );
    expect(invalidDueAt.error).toBe("Unable to parse due date/time from 'sometime soon'.");
  });
});

function createMockBackendClient(
  overrides?: Partial<ReminderBackendClient>,
): ReminderBackendClient {
  return {
    async createReminder(params) {
      if (overrides?.createReminder) {
        return overrides.createReminder(params);
      }

      return {
        id: "rem-default",
        title: params.title,
        description: params.description,
        dueAt: params.dueAt,
        priority: params.priority,
        recurrence: params.recurrence,
      };
    },
    async listReminders(params) {
      if (overrides?.listReminders) {
        return overrides.listReminders(params);
      }

      const dueAt = new Date().toISOString();
      return [{ id: "rem-list", title: "Default reminder", dueAt }];
    },
    async snoozeReminder(id, minutes) {
      if (overrides?.snoozeReminder) {
        return overrides.snoozeReminder(id, minutes);
      }

      return {
        id,
        title: "Default reminder",
        dueAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      };
    },
    async dismissReminder(id) {
      if (overrides?.dismissReminder) {
        return overrides.dismissReminder(id);
      }
    },
    async completeReminder(id) {
      if (overrides?.completeReminder) {
        return overrides.completeReminder(id);
      }
    },
  };
}
