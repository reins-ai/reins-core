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

  it("creates reminder with 'tomorrow at 3pm' NL due date", async () => {
    let capturedDueAt: string | undefined;
    const tool = new RemindersTool(
      createMockBackendClient({
        async createReminder(params) {
          capturedDueAt = params.dueAt;
          return {
            id: "rem-nl-1",
            title: params.title,
            dueAt: params.dueAt,
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-nl-tomorrow",
        action: "create",
        title: "Doctor appointment",
        dueAt: "tomorrow at 3pm",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; reminder: ReminderData };
    expect(payload.action).toBe("create_reminder");
    expect(capturedDueAt).toBeDefined();

    const parsed = new Date(capturedDueAt as string);
    expect(parsed.getTime()).not.toBeNaN();

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(15, 0, 0, 0);
    expect(parsed.getFullYear()).toBe(tomorrow.getFullYear());
    expect(parsed.getMonth()).toBe(tomorrow.getMonth());
    expect(parsed.getDate()).toBe(tomorrow.getDate());
    expect(parsed.getHours()).toBe(15);
  });

  it("creates reminder with 'in 30 minutes' NL due date", async () => {
    const before = Date.now();
    let capturedDueAt: string | undefined;
    const tool = new RemindersTool(
      createMockBackendClient({
        async createReminder(params) {
          capturedDueAt = params.dueAt;
          return {
            id: "rem-nl-2",
            title: params.title,
            dueAt: params.dueAt,
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-nl-30min",
        action: "create",
        title: "Take medicine",
        dueAt: "in 30 minutes",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedDueAt).toBeDefined();

    const parsed = new Date(capturedDueAt as string).getTime();
    const thirtyMinMs = 30 * 60_000;
    expect(parsed).toBeGreaterThanOrEqual(before + thirtyMinMs - 1_000);
    expect(parsed).toBeLessThanOrEqual(Date.now() + thirtyMinMs + 1_000);
  });

  it("passes ISO date strings through unchanged", async () => {
    let capturedDueAt: string | undefined;
    const isoDate = "2026-03-15T14:30:00.000Z";
    const tool = new RemindersTool(
      createMockBackendClient({
        async createReminder(params) {
          capturedDueAt = params.dueAt;
          return {
            id: "rem-iso",
            title: params.title,
            dueAt: params.dueAt,
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-iso",
        action: "create",
        title: "Meeting",
        dueAt: isoDate,
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedDueAt).toBe(isoDate);
  });

  it("returns clear error for unrecognized NL due date", async () => {
    const tool = new RemindersTool(createMockBackendClient());

    const result = await tool.execute(
      {
        callId: "call-bad-nl",
        action: "create",
        title: "Something",
        dueAt: "when pigs fly",
      },
      toolContext,
    );

    expect(result.error).toBe(
      "Could not parse due date: 'when pigs fly'. Please use an ISO date string or a recognized time phrase.",
    );
  });

  it("returns clear error for recurring NL phrase used as due date", async () => {
    const tool = new RemindersTool(createMockBackendClient());

    const result = await tool.execute(
      {
        callId: "call-recurring",
        action: "create",
        title: "Standup",
        dueAt: "every morning",
      },
      toolContext,
    );

    expect(result.error).toBe(
      "Recurring reminders aren't supported. Use the schedule tool instead (e.g. 'every Monday at 9:00 AM').",
    );
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
    expect(invalidDueAt.error).toBe(
      "Could not parse due date: 'sometime soon'. Please use an ISO date string or a recognized time phrase.",
    );
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
