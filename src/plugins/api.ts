import { PluginError } from "../errors";
import type { ConversationSummary, MessageRole, PluginPermission } from "../types";

export interface MessageSummary {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: Date;
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  startAt: Date;
  endAt: Date;
}

export interface NoteSummary {
  id: string;
  title: string;
  content: string;
  updatedAt: Date;
}

export interface ReminderSummary {
  id: string;
  title: string;
  dueAt: Date;
  completed: boolean;
}

export interface PluginDataAccess {
  conversations: ConversationDataAPI;
  calendar: CalendarDataAPI;
  notes: NotesDataAPI;
  reminders: RemindersDataAPI;
}

export interface ConversationDataAPI {
  list(params: { limit?: number }): Promise<ConversationSummary[]>;
  getMessages(conversationId: string, params: { limit?: number }): Promise<MessageSummary[]>;
}

export interface CalendarDataAPI {
  list(params: { limit?: number }): Promise<CalendarEventSummary[]>;
  create(input: { title: string; startAt: Date; endAt: Date }): Promise<CalendarEventSummary>;
}

export interface NotesDataAPI {
  list(params: { limit?: number }): Promise<NoteSummary[]>;
  create(input: { title: string; content: string }): Promise<NoteSummary>;
}

export interface RemindersDataAPI {
  list(params: { limit?: number }): Promise<ReminderSummary[]>;
  create(input: { title: string; dueAt: Date }): Promise<ReminderSummary>;
}

export class StubPluginDataAccess implements PluginDataAccess {
  public readonly conversations: ConversationDataAPI = {
    list: async () => [],
    getMessages: async () => [],
  };

  public readonly calendar: CalendarDataAPI = {
    list: async () => [],
    create: async (input) => ({
      id: "calendar-stub-event",
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
    }),
  };

  public readonly notes: NotesDataAPI = {
    list: async () => [],
    create: async (input) => ({
      id: "notes-stub-note",
      title: input.title,
      content: input.content,
      updatedAt: new Date(),
    }),
  };

  public readonly reminders: RemindersDataAPI = {
    list: async () => [],
    create: async (input) => ({
      id: "reminders-stub-reminder",
      title: input.title,
      dueAt: input.dueAt,
      completed: false,
    }),
  };
}

export function createScopedPluginDataAccess(
  pluginName: string,
  permissions: PluginPermission[],
  dataAccess: PluginDataAccess,
): PluginDataAccess {
  const permissionSet = new Set<PluginPermission>(permissions);

  return {
    conversations: {
      list: async (params) => {
        assertPermission(permissionSet, pluginName, "read_conversations");
        return dataAccess.conversations.list(params);
      },
      getMessages: async (conversationId, params) => {
        assertPermission(permissionSet, pluginName, "read_conversations");
        return dataAccess.conversations.getMessages(conversationId, params);
      },
    },
    calendar: {
      list: async (params) => {
        assertPermission(permissionSet, pluginName, "read_calendar");
        return dataAccess.calendar.list(params);
      },
      create: async (input) => {
        assertPermission(permissionSet, pluginName, "write_calendar");
        return dataAccess.calendar.create(input);
      },
    },
    notes: {
      list: async (params) => {
        assertPermission(permissionSet, pluginName, "read_notes");
        return dataAccess.notes.list(params);
      },
      create: async (input) => {
        assertPermission(permissionSet, pluginName, "write_notes");
        return dataAccess.notes.create(input);
      },
    },
    reminders: {
      list: async (params) => {
        assertPermission(permissionSet, pluginName, "read_reminders");
        return dataAccess.reminders.list(params);
      },
      create: async (input) => {
        assertPermission(permissionSet, pluginName, "write_reminders");
        return dataAccess.reminders.create(input);
      },
    },
  };
}

function assertPermission(
  permissionSet: Set<PluginPermission>,
  pluginName: string,
  permission: PluginPermission,
): void {
  if (!permissionSet.has(permission)) {
    throw new PluginError(`Plugin ${pluginName} is missing required permission: ${permission}`);
  }
}
