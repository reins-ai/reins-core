import { parseNlTime } from "./date-parser";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";

const ISO_DATE_PREFIX_PATTERN = /^\d{4}-/;

type ReminderPriority = "low" | "medium" | "high" | "urgent";
type ReminderAction =
  | "create"
  | "list"
  | "snooze"
  | "dismiss"
  | "complete"
  | "create_reminder"
  | "list_reminders"
  | "snooze_reminder"
  | "dismiss_reminder"
  | "complete_reminder";

export interface ReminderData {
  id: string;
  title: string;
  description?: string;
  dueAt: string;
  status?: string;
  priority?: ReminderPriority;
  recurrence?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateReminderParams {
  title: string;
  description?: string;
  dueAt: string;
  priority?: ReminderPriority;
  recurrence?: Record<string, unknown>;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface ListReminderParams {
  status?: string;
  priority?: ReminderPriority;
  limit?: number;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface ReminderBackendClient {
  createReminder(params: CreateReminderParams): Promise<ReminderData>;
  listReminders(params: ListReminderParams): Promise<ReminderData[]>;
  snoozeReminder(id: string, minutes: number): Promise<ReminderData>;
  dismissReminder(id: string): Promise<void>;
  completeReminder(id: string): Promise<void>;
}

export class RemindersTool implements Tool {
  definition: ToolDefinition = {
    name: "reminders",
    description:
      "Create, list, and manage reminders. Supports snooze, dismiss, and completion.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: [
            "create",
            "list",
            "snooze",
            "dismiss",
            "complete",
            "create_reminder",
            "list_reminders",
            "snooze_reminder",
            "dismiss_reminder",
            "complete_reminder",
          ],
        },
        title: {
          type: "string",
          description: "Reminder title used by create actions.",
        },
        description: {
          type: "string",
          description: "Optional description used by create actions.",
        },
        dueAt: {
          type: "string",
          description:
            "Reminder due time. Accepts ISO or natural language like 'in 30 minutes' or 'tomorrow at 5pm'.",
        },
        priority: {
          type: "string",
          description: "Reminder priority filter or value.",
          enum: ["low", "medium", "high", "urgent"],
        },
        status: {
          type: "string",
          description: "Reminder status filter used by list actions.",
        },
        reminderId: {
          type: "string",
          description: "Reminder ID used by snooze, dismiss, and complete actions.",
        },
        minutes: {
          type: "number",
          description: "Minutes to snooze. Defaults to 15.",
        },
        limit: {
          type: "number",
          description: "Maximum number of reminders to return when listing.",
        },
        recurrence: {
          type: "object",
          description: "Optional recurrence configuration for create actions.",
        },
      },
      required: ["action"],
    },
  };

  constructor(private readonly backendClient: ReminderBackendClient) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";
    const action = this.normalizeAction(args.action);

    if (!action) {
      return this.errorResult(callId, "Missing or invalid 'action' argument.");
    }

    try {
      switch (action) {
        case "create":
          return await this.createReminder(callId, args, context);
        case "list":
          return await this.listReminders(callId, args, context);
        case "snooze":
          return await this.snoozeReminder(callId, args);
        case "dismiss":
          return await this.dismissReminder(callId, args);
        case "complete":
          return await this.completeReminder(callId, args);
      }
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private async createReminder(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const title = this.requireString(args.title, "'title' is required for create action.");
    const dueAtInput = this.requireString(args.dueAt, "'dueAt' is required for create action.");
    const description = this.optionalString(args.description);
    const priority = this.optionalPriority(args.priority);
    const recurrence = this.optionalObject(args.recurrence, "'recurrence' must be an object.");

    const dueAtIso = this.resolveDueAt(dueAtInput);
    if (typeof dueAtIso !== "string") {
      return this.errorResult(callId, dueAtIso.error);
    }

    const reminder = await this.backendClient.createReminder({
      title,
      description,
      dueAt: dueAtIso,
      priority,
      recurrence,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "create_reminder",
      reminder,
    });
  }

  private async listReminders(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const status = this.optionalString(args.status);
    const priority = this.optionalPriority(args.priority);
    const limit = this.optionalPositiveInteger(args.limit, "'limit' must be a positive integer.");

    const reminders = await this.backendClient.listReminders({
      status,
      priority,
      limit,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "list_reminders",
      reminders,
      count: reminders.length,
    });
  }

  private async snoozeReminder(callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const reminderId = this.requireString(
      args.reminderId,
      "'reminderId' is required for snooze action.",
    );
    const minutes =
      this.optionalPositiveInteger(args.minutes, "'minutes' must be a positive integer.") ?? 15;

    const reminder = await this.backendClient.snoozeReminder(reminderId, minutes);

    return this.successResult(callId, {
      action: "snooze_reminder",
      reminder,
      minutes,
    });
  }

  private async dismissReminder(callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const reminderId = this.requireString(
      args.reminderId,
      "'reminderId' is required for dismiss action.",
    );

    await this.backendClient.dismissReminder(reminderId);

    return this.successResult(callId, {
      action: "dismiss_reminder",
      reminderId,
      success: true,
    });
  }

  private async completeReminder(callId: string, args: Record<string, unknown>): Promise<ToolResult> {
    const reminderId = this.requireString(
      args.reminderId,
      "'reminderId' is required for complete action.",
    );

    await this.backendClient.completeReminder(reminderId);

    return this.successResult(callId, {
      action: "complete_reminder",
      reminderId,
      success: true,
    });
  }

  private resolveDueAt(input: string): string | { error: string } {
    if (ISO_DATE_PREFIX_PATTERN.test(input)) {
      return input;
    }

    const parsed = parseNlTime(input);
    if (!parsed || !parsed.runAt) {
      return {
        error: `Could not parse due date: '${input}'. Please use an ISO date string or a recognized time phrase.`,
      };
    }

    return parsed.runAt.toISOString();
  }

  private normalizeAction(value: unknown): "create" | "list" | "snooze" | "dismiss" | "complete" | null {
    const action = this.readString(value);
    if (!action) {
      return null;
    }

    const map: Record<ReminderAction, "create" | "list" | "snooze" | "dismiss" | "complete"> = {
      create: "create",
      list: "list",
      snooze: "snooze",
      dismiss: "dismiss",
      complete: "complete",
      create_reminder: "create",
      list_reminders: "list",
      snooze_reminder: "snooze",
      dismiss_reminder: "dismiss",
      complete_reminder: "complete",
    };

    return map[action as ReminderAction] ?? null;
  }

  private successResult(callId: string, result: unknown): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result,
    };
  }

  private errorResult(callId: string, error: string): ToolResult {
    return {
      callId,
      name: this.definition.name,
      result: null,
      error,
    };
  }

  private readString(value: unknown): string | null {
    if (typeof value !== "string") {
      return null;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private requireString(value: unknown, message: string): string {
    const read = this.readString(value);
    if (!read) {
      throw new Error(message);
    }
    return read;
  }

  private optionalString(value: unknown): string | undefined {
    const read = this.readString(value);
    return read ?? undefined;
  }

  private optionalObject(value: unknown, message: string): Record<string, unknown> | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(message);
    }

    return value as Record<string, unknown>;
  }

  private optionalPriority(value: unknown): ReminderPriority | undefined {
    if (value === undefined) {
      return undefined;
    }

    const priority = this.readString(value);
    if (!priority) {
      throw new Error("'priority' must be one of: low, medium, high, urgent.");
    }

    if (priority === "low" || priority === "medium" || priority === "high" || priority === "urgent") {
      return priority;
    }

    throw new Error("'priority' must be one of: low, medium, high, urgent.");
  }

  private optionalPositiveInteger(value: unknown, message: string): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(message);
    }

    return value;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Reminders tool execution failed.";
  }
}
