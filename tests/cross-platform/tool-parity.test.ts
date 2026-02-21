import { describe, expect, it } from "bun:test";

import {
  CalendarTool,
  NotesTool,
  RemindersTool,
  deserializeToolCall,
  deserializeToolResult,
  serializeToolCall,
  serializeToolResult,
  type CalendarBackendClient,
  type NoteBackendClient,
  type ReminderBackendClient,
} from "../../src/tools";
import type { ToolCall, ToolContext, ToolResult } from "../../src/types";

type Platform = "tui" | "desktop" | "mobile";

const platforms: Platform[] = ["tui", "desktop", "mobile"];

const context: ToolContext = {
  conversationId: "conv-parity",
  userId: "user-parity",
  workspaceId: "ws-parity",
};

function createCalendarBackend(): CalendarBackendClient {
  return {
    async createEvent(params) {
      return {
        id: "evt-100",
        title: params.title,
        startTime: params.startTime,
        endTime: params.endTime,
        description: params.description,
        location: params.location,
        allDay: params.allDay,
      };
    },
    async listEvents(params) {
      return [
        {
          id: "evt-100",
          title: "Planning Session",
          startTime: params.start,
          endTime: params.end,
          location: "Room A",
        },
      ];
    },
    async updateEvent(params) {
      return {
        id: params.eventId,
        title: params.title ?? "Planning Session",
        startTime: params.startTime ?? "2026-03-01T09:00:00.000Z",
        endTime: params.endTime ?? "2026-03-01T10:00:00.000Z",
      };
    },
    async deleteEvent() {},
    async getDayView(params) {
      return [
        {
          id: "evt-day-1",
          title: "Daily Sync",
          startTime: params.date,
          endTime: "2026-03-01T10:00:00.000Z",
        },
      ];
    },
  };
}

function createReminderBackend(): ReminderBackendClient {
  return {
    async createReminder(params) {
      return {
        id: "rem-100",
        title: params.title,
        dueAt: params.dueAt,
        priority: params.priority,
      };
    },
    async listReminders() {
      return [
        {
          id: "rem-100",
          title: "Ship release",
          dueAt: "2026-03-05T12:00:00.000Z",
          priority: "high",
        },
      ];
    },
    async snoozeReminder(id, minutes) {
      const dueAt = new Date(Date.parse("2026-03-05T12:00:00.000Z") + minutes * 60_000).toISOString();
      return {
        id,
        title: "Ship release",
        dueAt,
        priority: "high",
      };
    },
    async dismissReminder() {},
    async completeReminder() {},
  };
}

function createNotesBackend(): NoteBackendClient {
  return {
    async createNote(params) {
      return {
        id: "note-100",
        title: params.title,
        content: params.content,
        tags: params.tags ?? [],
        folderId: params.folderId,
        isPinned: false,
        wordCount: params.content.split(/\s+/).length,
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      };
    },
    async getNote(params) {
      return {
        id: params.noteId,
        title: "Saved Note",
        content: "- item one\n- item two",
        tags: ["work"],
        isPinned: false,
        wordCount: 4,
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      };
    },
    async updateNote(params) {
      return {
        id: params.noteId,
        title: params.title ?? "Saved Note",
        content: params.content ?? "- item one\n- item two",
        tags: params.tags ?? ["work"],
        folderId: params.folderId,
        isPinned: params.isPinned ?? false,
        wordCount: 4,
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:10:00.000Z",
      };
    },
    async deleteNote() {},
    async listNotes() {
      return [
        {
          id: "note-100",
          title: "Saved Note",
          content: "- item one\n- item two",
          tags: ["work"],
          isPinned: false,
          wordCount: 4,
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        },
      ];
    },
    async searchNotes() {
      return [
        {
          id: "note-100",
          title: "Saved Note",
          content: "- item one\n- item two",
          tags: ["work"],
          isPinned: false,
          wordCount: 4,
          createdAt: "2026-03-01T12:00:00.000Z",
          updatedAt: "2026-03-01T12:00:00.000Z",
        },
      ];
    },
    async addTag(params) {
      return {
        id: params.noteId,
        title: "Saved Note",
        content: "- item one\n- item two",
        tags: ["work", params.tag],
        isPinned: false,
        wordCount: 4,
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      };
    },
    async removeTag(params) {
      return {
        id: params.noteId,
        title: "Saved Note",
        content: "- item one\n- item two",
        tags: ["work"],
        isPinned: false,
        wordCount: 4,
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      };
    },
    async togglePin(params) {
      return {
        id: params.noteId,
        title: "Saved Note",
        content: "- item one\n- item two",
        tags: ["work"],
        isPinned: true,
        wordCount: 4,
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      };
    },
    async moveToFolder(params) {
      return {
        id: params.noteId,
        title: "Saved Note",
        content: "- item one\n- item two",
        tags: ["work"],
        folderId: params.folderId,
        isPinned: false,
        wordCount: 4,
        createdAt: "2026-03-01T12:00:00.000Z",
        updatedAt: "2026-03-01T12:00:00.000Z",
      };
    },
  };
}

async function runCalendar(platform: Platform): Promise<ToolResult> {
  const tool = new CalendarTool(createCalendarBackend());
  return tool.execute(
    {
      callId: `calendar-${platform}`,
      action: "create_event",
      title: "Planning Session",
      startTime: "2026-03-01T09:00:00.000Z",
      endTime: "2026-03-01T10:00:00.000Z",
      location: "Room A",
    },
    context,
  );
}

async function runReminders(platform: Platform): Promise<ToolResult> {
  const tool = new RemindersTool(createReminderBackend());
  return tool.execute(
    {
      callId: `reminders-${platform}`,
      action: "create",
      title: "Ship release",
      dueAt: "2026-03-05T12:00:00.000Z",
      priority: "high",
    },
    context,
  );
}

async function runNotes(platform: Platform): Promise<ToolResult> {
  const tool = new NotesTool(createNotesBackend());
  return tool.execute(
    {
      callId: `notes-${platform}`,
      action: "create_note",
      title: "Release notes",
      content: "- update changelog\n- publish release",
      tags: ["release", "ops"],
    },
    context,
  );
}

describe("cross-platform/tool-parity", () => {
  it("returns identical Calendar output for the same input", async () => {
    const baseline = await runCalendar("tui");
    const desktop = await runCalendar("desktop");
    const mobile = await runCalendar("mobile");

    expect(desktop).toEqual({ ...baseline, callId: "calendar-desktop" });
    expect(mobile).toEqual({ ...baseline, callId: "calendar-mobile" });
  });

  it("returns identical Reminders output for the same input", async () => {
    const baseline = await runReminders("tui");
    const desktop = await runReminders("desktop");
    const mobile = await runReminders("mobile");

    expect(desktop.name).toBe(baseline.name);
    expect(mobile.name).toBe(baseline.name);
    expect(desktop.error).toBeUndefined();
    expect(mobile.error).toBeUndefined();
    expect(desktop.result).toEqual(mobile.result);
  });

  it("returns identical Notes output for the same input", async () => {
    const baseline = await runNotes("tui");
    const desktop = await runNotes("desktop");
    const mobile = await runNotes("mobile");

    expect(desktop.result).toEqual(baseline.result);
    expect(mobile.result).toEqual(baseline.result);
  });

  it("keeps tool serialization platform-agnostic", () => {
    const call: ToolCall = {
      id: "tool-call-1",
      name: "notes",
      arguments: {
        action: "search_notes",
        query: "release",
      },
    };

    const result: ToolResult = {
      callId: "tool-call-1",
      name: "notes",
      result: {
        action: "search_notes",
        count: 1,
      },
    };

    const serializedCall = serializeToolCall(call);
    const serializedResult = serializeToolResult(result);

    for (const _platform of platforms) {
      expect(deserializeToolCall(serializedCall)).toEqual(call);
      expect(deserializeToolResult(serializedResult)).toEqual(result);
    }
  });
});
