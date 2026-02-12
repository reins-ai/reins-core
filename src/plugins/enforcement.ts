import type {
  CalendarDataAPI,
  ConversationDataAPI,
  NotesDataAPI,
  PluginDataAccess,
  RemindersDataAPI,
} from "./api";
import { enforcePermission, type PermissionChecker } from "./permissions";

export class EnforcedDataAccess implements PluginDataAccess {
  constructor(
    private readonly inner: PluginDataAccess,
    private readonly checker: PermissionChecker,
  ) {}

  get conversations(): ConversationDataAPI {
    return {
      list: async (params) => {
        enforcePermission(this.checker, "read_conversations", "conversations.list");
        return this.inner.conversations.list(params);
      },
      getMessages: async (conversationId, params) => {
        enforcePermission(this.checker, "read_conversations", "conversations.getMessages");
        return this.inner.conversations.getMessages(conversationId, params);
      },
    };
  }

  get calendar(): CalendarDataAPI {
    return {
      list: async (params) => {
        enforcePermission(this.checker, "read_calendar", "calendar.list");
        return this.inner.calendar.list(params);
      },
      create: async (input) => {
        enforcePermission(this.checker, "write_calendar", "calendar.create");
        return this.inner.calendar.create(input);
      },
    };
  }

  get notes(): NotesDataAPI {
    return {
      list: async (params) => {
        enforcePermission(this.checker, "read_notes", "notes.list");
        return this.inner.notes.list(params);
      },
      create: async (input) => {
        enforcePermission(this.checker, "write_notes", "notes.create");
        return this.inner.notes.create(input);
      },
    };
  }

  get reminders(): RemindersDataAPI {
    return {
      list: async (params) => {
        enforcePermission(this.checker, "read_reminders", "reminders.list");
        return this.inner.reminders.list(params);
      },
      create: async (input) => {
        enforcePermission(this.checker, "write_reminders", "reminders.create");
        return this.inner.reminders.create(input);
      },
    };
  }
}

export class PermissionGuard {
  constructor(private readonly checker: PermissionChecker) {}

  assertNetworkAccess(action = "network.request"): void {
    enforcePermission(this.checker, "network_access", action);
  }

  assertFileAccess(action = "file.access"): void {
    enforcePermission(this.checker, "file_access", action);
  }

  async runWithNetworkAccess<T>(action: string, operation: () => Promise<T>): Promise<T> {
    this.assertNetworkAccess(action);
    return operation();
  }

  async runWithFileAccess<T>(action: string, operation: () => Promise<T>): Promise<T> {
    this.assertFileAccess(action);
    return operation();
  }
}
