import { describe, expect, it } from "bun:test";

import {
  CalendarTool,
  ToolRegistry,
  type CalendarBackendClient,
  type CalendarEventData,
} from "../../src/tools";
import type { ToolContext } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-123",
  userId: "user-123",
  workspaceId: "ws-123",
};

describe("CalendarTool", () => {
  it("registers in ToolRegistry and exposes definition", () => {
    const tool = new CalendarTool(createMockBackendClient());
    const registry = new ToolRegistry();

    registry.register(tool);

    const definition = registry.getDefinitions()[0];
    expect(definition?.name).toBe("calendar");
    expect(definition?.parameters.required).toEqual(["action"]);
  });

  it("creates events using natural language startTime and default endTime", async () => {
    let capturedStartTime: string | undefined;
    let capturedEndTime: string | undefined;

    const tool = new CalendarTool(
      createMockBackendClient({
        async createEvent(params) {
          capturedStartTime = params.startTime;
          capturedEndTime = params.endTime;

          return {
            id: "evt-1",
            title: params.title,
            startTime: params.startTime,
            endTime: params.endTime,
            location: params.location,
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-create",
        action: "create_event",
        title: "Team sync",
        startTime: "tomorrow at 3pm",
        location: "Room A",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; event: CalendarEventData };
    expect(payload.action).toBe("create_event");
    expect(payload.event.title).toBe("Team sync");
    expect(payload.event.location).toBe("Room A");
    expect(capturedStartTime).toBeDefined();
    expect(capturedEndTime).toBeDefined();
    expect(Date.parse(capturedStartTime as string)).not.toBeNaN();
    expect(Date.parse(capturedEndTime as string)).not.toBeNaN();

    const duration = Date.parse(capturedEndTime as string) - Date.parse(capturedStartTime as string);
    expect(duration).toBe(60 * 60 * 1000);
  });

  it("lists events with natural language range", async () => {
    let capturedStart: string | undefined;
    let capturedEnd: string | undefined;
    let capturedLimit: number | undefined;

    const tool = new CalendarTool(
      createMockBackendClient({
        async listEvents(params) {
          capturedStart = params.start;
          capturedEnd = params.end;
          capturedLimit = params.limit;
          return [
            {
              id: "evt-1",
              title: "Planning",
              startTime: params.start,
              endTime: params.end,
            },
          ];
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-list",
        action: "list_events",
        start: "today",
        end: "next week",
        limit: 10,
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; events: CalendarEventData[]; count: number };
    expect(payload.action).toBe("list_events");
    expect(payload.count).toBe(1);
    expect(capturedStart).toBeDefined();
    expect(capturedEnd).toBeDefined();
    expect(capturedLimit).toBe(10);
    expect(Date.parse(capturedStart as string)).not.toBeNaN();
    expect(Date.parse(capturedEnd as string)).not.toBeNaN();
  });

  it("updates event fields", async () => {
    let capturedEventId: string | undefined;
    let capturedTitle: string | undefined;
    let capturedStartTime: string | undefined;

    const tool = new CalendarTool(
      createMockBackendClient({
        async updateEvent(params) {
          capturedEventId = params.eventId;
          capturedTitle = params.title;
          capturedStartTime = params.startTime;

          return {
            id: params.eventId,
            title: params.title ?? "Original",
            startTime: params.startTime ?? new Date().toISOString(),
            endTime: params.endTime ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          };
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-update",
        action: "update_event",
        eventId: "evt-42",
        title: "Updated title",
        startTime: "next monday at 10am",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; event: CalendarEventData };
    expect(payload.action).toBe("update_event");
    expect(capturedEventId).toBe("evt-42");
    expect(capturedTitle).toBe("Updated title");
    expect(capturedStartTime).toBeDefined();
    expect(Date.parse(capturedStartTime as string)).not.toBeNaN();
  });

  it("deletes events", async () => {
    let deletedEventId: string | undefined;

    const tool = new CalendarTool(
      createMockBackendClient({
        async deleteEvent(params) {
          deletedEventId = params.eventId;
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-delete",
        action: "delete_event",
        eventId: "evt-delete",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(deletedEventId).toBe("evt-delete");
    expect(result.result).toEqual({ action: "delete_event", eventId: "evt-delete", success: true });
  });

  it("returns day view with natural language date", async () => {
    let capturedDate: string | undefined;

    const tool = new CalendarTool(
      createMockBackendClient({
        async getDayView(params) {
          capturedDate = params.date;
          return [
            {
              id: "evt-day",
              title: "Daily standup",
              startTime: params.date,
              endTime: new Date(Date.parse(params.date) + 30 * 60 * 1000).toISOString(),
            },
          ];
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-day",
        action: "get_day_view",
        date: "tomorrow",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as {
      action: string;
      date: string;
      events: CalendarEventData[];
      count: number;
    };
    expect(payload.action).toBe("get_day_view");
    expect(payload.count).toBe(1);
    expect(capturedDate).toBeDefined();
    expect(Date.parse(capturedDate as string)).not.toBeNaN();
  });

  it("returns validation errors for invalid arguments", async () => {
    const tool = new CalendarTool(createMockBackendClient());

    const missingAction = await tool.execute({}, toolContext);
    expect(missingAction.error).toBe("Missing or invalid 'action' argument.");

    const missingTitle = await tool.execute(
      {
        action: "create_event",
        startTime: "tomorrow at 3pm",
      },
      toolContext,
    );
    expect(missingTitle.error).toBe("'title' is required for create_event action.");

    const invalidStartTime = await tool.execute(
      {
        action: "create_event",
        title: "Event",
        startTime: "sometime soon",
      },
      toolContext,
    );
    expect(invalidStartTime.error).toBe("Unable to parse startTime from 'sometime soon'.");

    const invalidUpdate = await tool.execute(
      {
        action: "update_event",
        eventId: "evt-1",
      },
      toolContext,
    );
    expect(invalidUpdate.error).toBe("At least one field must be provided for update_event action.");
  });
});

function createMockBackendClient(
  overrides?: Partial<CalendarBackendClient>,
): CalendarBackendClient {
  return {
    async createEvent(params) {
      if (overrides?.createEvent) {
        return overrides.createEvent(params);
      }

      return {
        id: "evt-default",
        title: params.title,
        description: params.description,
        startTime: params.startTime,
        endTime: params.endTime,
        location: params.location,
        allDay: params.allDay,
        recurrence: params.recurrence,
      };
    },
    async listEvents(params) {
      if (overrides?.listEvents) {
        return overrides.listEvents(params);
      }

      return [
        {
          id: "evt-list",
          title: "Default event",
          startTime: params.start,
          endTime: params.end,
        },
      ];
    },
    async updateEvent(params) {
      if (overrides?.updateEvent) {
        return overrides.updateEvent(params);
      }

      return {
        id: params.eventId,
        title: params.title ?? "Updated event",
        description: params.description,
        startTime: params.startTime ?? new Date().toISOString(),
        endTime: params.endTime ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        location: params.location,
        allDay: params.allDay,
        recurrence: params.recurrence,
      };
    },
    async deleteEvent(params) {
      if (overrides?.deleteEvent) {
        return overrides.deleteEvent(params);
      }
    },
    async getDayView(params) {
      if (overrides?.getDayView) {
        return overrides.getDayView(params);
      }

      return [
        {
          id: "evt-day-default",
          title: "Default day event",
          startTime: params.date,
          endTime: new Date(Date.parse(params.date) + 60 * 60 * 1000).toISOString(),
        },
      ];
    },
  };
}
