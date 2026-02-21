import type {
  CalendarDataAPI,
  CalendarEventSummary,
  ConversationDataAPI,
  NoteSummary,
  NotesDataAPI,
  PluginDataAccess,
  ReminderSummary,
  RemindersDataAPI,
} from "../../../src/plugins/api";

/**
 * Test-only stub that returns predictable fake data for all PluginDataAccess
 * operations. Use this in tests where a full data access implementation is
 * not needed but create operations must succeed.
 */
export class StubPluginDataAccess implements PluginDataAccess {
  public readonly conversations: ConversationDataAPI = {
    list: async () => [],
    getMessages: async () => [],
  };

  public readonly calendar: CalendarDataAPI = {
    list: async () => [],
    create: async (input): Promise<CalendarEventSummary> => ({
      id: "test-calendar-event",
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
    }),
  };

  public readonly notes: NotesDataAPI = {
    list: async () => [],
    create: async (input): Promise<NoteSummary> => ({
      id: "test-note",
      title: input.title,
      content: input.content,
      updatedAt: new Date(),
    }),
  };

  public readonly reminders: RemindersDataAPI = {
    list: async () => [],
    create: async (input): Promise<ReminderSummary> => ({
      id: "test-reminder",
      title: input.title,
      dueAt: input.dueAt,
      completed: false,
    }),
  };
}
