import { parseRelativeTime } from "./date-parser";
import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";

type CalendarAction =
  | "create_event"
  | "list_events"
  | "update_event"
  | "delete_event"
  | "get_day_view";

export interface CalendarEventData {
  id: string;
  title: string;
  description?: string;
  startTime: string;
  endTime: string;
  location?: string;
  allDay?: boolean;
  recurrence?: Record<string, unknown>;
  status?: string;
}

export interface CreateEventParams {
  title: string;
  startTime: string;
  endTime: string;
  description?: string;
  location?: string;
  allDay?: boolean;
  recurrence?: Record<string, unknown>;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface ListEventsParams {
  start: string;
  end: string;
  limit?: number;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface UpdateEventParams {
  eventId: string;
  title?: string;
  startTime?: string;
  endTime?: string;
  description?: string;
  location?: string;
  allDay?: boolean;
  recurrence?: Record<string, unknown>;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface DeleteEventParams {
  eventId: string;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface DayViewParams {
  date: string;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface CalendarBackendClient {
  createEvent(params: CreateEventParams): Promise<CalendarEventData>;
  listEvents(params: ListEventsParams): Promise<CalendarEventData[]>;
  updateEvent(params: UpdateEventParams): Promise<CalendarEventData>;
  deleteEvent(params: DeleteEventParams): Promise<void>;
  getDayView(params: DayViewParams): Promise<CalendarEventData[]>;
}

export class CalendarTool implements Tool {
  definition: ToolDefinition = {
    name: "calendar",
    description:
      "Create, list, update, and delete calendar events. Supports recurring events and day view.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "The action to perform.",
          enum: ["create_event", "list_events", "update_event", "delete_event", "get_day_view"],
        },
        title: {
          type: "string",
          description: "Event title used by create_event and update_event.",
        },
        description: {
          type: "string",
          description: "Optional event description.",
        },
        startTime: {
          type: "string",
          description:
            "Event start time. Accepts ISO or natural language like 'tomorrow at 3pm' or 'next Monday at 10am'.",
        },
        endTime: {
          type: "string",
          description:
            "Event end time. Accepts ISO or natural language. Defaults to one hour after start time for create_event.",
        },
        location: {
          type: "string",
          description: "Optional event location.",
        },
        allDay: {
          type: "boolean",
          description: "Whether the event is an all-day event.",
        },
        recurrence: {
          type: "object",
          description: "Optional recurrence configuration.",
        },
        eventId: {
          type: "string",
          description: "Event ID used by update_event and delete_event.",
        },
        start: {
          type: "string",
          description:
            "Range start for list_events. Accepts ISO or natural language. Defaults to today at 00:00.",
        },
        end: {
          type: "string",
          description:
            "Range end for list_events. Accepts ISO or natural language. Defaults to 7 days after range start.",
        },
        limit: {
          type: "number",
          description: "Maximum number of events to return for list_events.",
        },
        date: {
          type: "string",
          description:
            "Day selector for get_day_view. Accepts natural language like 'today', 'tomorrow', or 'next monday'.",
        },
      },
      required: ["action"],
    },
  };

  constructor(private readonly backendClient: CalendarBackendClient) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";
    const action = this.normalizeAction(args.action);

    if (!action) {
      return this.errorResult(callId, "Missing or invalid 'action' argument.");
    }

    try {
      switch (action) {
        case "create_event":
          return await this.createEvent(callId, args, context);
        case "list_events":
          return await this.listEvents(callId, args, context);
        case "update_event":
          return await this.updateEvent(callId, args, context);
        case "delete_event":
          return await this.deleteEvent(callId, args, context);
        case "get_day_view":
          return await this.getDayView(callId, args, context);
      }
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private async createEvent(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const title = this.requireString(args.title, "'title' is required for create_event action.");
    const startTimeInput = this.requireString(
      args.startTime,
      "'startTime' is required for create_event action.",
    );
    const endTimeInput = this.optionalString(args.endTime);
    const description = this.optionalString(args.description);
    const location = this.optionalString(args.location);
    const allDay = this.optionalBoolean(args.allDay, "'allDay' must be a boolean.");
    const recurrence = this.optionalObject(args.recurrence, "'recurrence' must be an object.");

    const startTime = this.parseDateTime(startTimeInput, "startTime", true);
    const endTime = endTimeInput
      ? this.parseDateTime(endTimeInput, "endTime", true)
      : new Date(startTime.getTime() + 60 * 60 * 1000);

    if (endTime.getTime() <= startTime.getTime()) {
      throw new Error("'endTime' must be after 'startTime'.");
    }

    const event = await this.backendClient.createEvent({
      title,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      description,
      location,
      allDay,
      recurrence,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "create_event",
      event,
    });
  }

  private async listEvents(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const startInput = this.optionalString(args.start);
    const endInput = this.optionalString(args.end);
    const limit = this.optionalPositiveInteger(args.limit, "'limit' must be a positive integer.");

    const startDate = startInput
      ? this.parseDateTime(startInput, "start", true)
      : this.startOfDay(new Date());
    const endDate = endInput
      ? this.parseDateTime(endInput, "end", true)
      : new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000);

    if (endDate.getTime() < startDate.getTime()) {
      throw new Error("'end' must be greater than or equal to 'start'.");
    }

    const events = await this.backendClient.listEvents({
      start: startDate.toISOString(),
      end: endDate.toISOString(),
      limit,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "list_events",
      events,
      count: events.length,
    });
  }

  private async updateEvent(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const eventId = this.requireString(args.eventId, "'eventId' is required for update_event action.");
    const title = this.optionalString(args.title);
    const description = this.optionalString(args.description);
    const location = this.optionalString(args.location);
    const allDay = this.optionalBoolean(args.allDay, "'allDay' must be a boolean.");
    const recurrence = this.optionalObject(args.recurrence, "'recurrence' must be an object.");

    const startTimeInput = this.optionalString(args.startTime);
    const endTimeInput = this.optionalString(args.endTime);
    const startTime = startTimeInput
      ? this.parseDateTime(startTimeInput, "startTime", true).toISOString()
      : undefined;
    const endTime = endTimeInput
      ? this.parseDateTime(endTimeInput, "endTime", true).toISOString()
      : undefined;

    if (startTime && endTime && Date.parse(endTime) <= Date.parse(startTime)) {
      throw new Error("'endTime' must be after 'startTime'.");
    }

    if (!title && !description && !location && !startTime && !endTime && allDay === undefined && !recurrence) {
      throw new Error("At least one field must be provided for update_event action.");
    }

    const event = await this.backendClient.updateEvent({
      eventId,
      title,
      description,
      location,
      startTime,
      endTime,
      allDay,
      recurrence,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "update_event",
      event,
    });
  }

  private async deleteEvent(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const eventId = this.requireString(args.eventId, "'eventId' is required for delete_event action.");

    await this.backendClient.deleteEvent({
      eventId,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "delete_event",
      eventId,
      success: true,
    });
  }

  private async getDayView(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const dateInput = this.optionalString(args.date);
    const date = dateInput ? this.parseDateTime(dateInput, "date", false) : new Date();
    const dayStart = this.startOfDay(date);

    const events = await this.backendClient.getDayView({
      date: dayStart.toISOString(),
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "get_day_view",
      date: dayStart.toISOString(),
      events,
      count: events.length,
    });
  }

  private normalizeAction(value: unknown): CalendarAction | null {
    const action = this.readString(value);
    if (!action) {
      return null;
    }

    if (
      action === "create_event" ||
      action === "list_events" ||
      action === "update_event" ||
      action === "delete_event" ||
      action === "get_day_view"
    ) {
      return action;
    }

    return null;
  }

  private parseDateTime(input: string, field: string, allowNaturalLanguage: boolean): Date {
    const normalizedInput = input.trim().toLowerCase();
    if (normalizedInput === "today" || normalizedInput === "now") {
      return new Date();
    }

    const directTimestamp = Date.parse(input);
    if (!Number.isNaN(directTimestamp)) {
      return new Date(directTimestamp);
    }

    if (allowNaturalLanguage || field === "date") {
      const parsed = parseRelativeTime(input);
      if (parsed?.runAt) {
        return parsed.runAt;
      }
    }

    throw new Error(`Unable to parse ${field} from '${input}'.`);
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

  private optionalBoolean(value: unknown, message: string): boolean | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "boolean") {
      throw new Error(message);
    }

    return value;
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

  private optionalPositiveInteger(value: unknown, message: string): number | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
      throw new Error(message);
    }

    return value;
  }

  private startOfDay(value: Date): Date {
    const dayStart = new Date(value);
    dayStart.setHours(0, 0, 0, 0);
    return dayStart;
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Calendar tool execution failed.";
  }
}
