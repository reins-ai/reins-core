/**
 * Static tool definitions for built-in tools.
 * These are extracted from tool classes so the daemon can pass them
 * to providers without needing to instantiate tools with backend clients.
 */

import type { ToolDefinition } from "../types";
import type { SystemToolDefinition } from "./system/types";

export const CALENDAR_DEFINITION: ToolDefinition = {
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

export const NOTES_DEFINITION: ToolDefinition = {
  name: "notes",
  description:
    "Create, search, update, and manage notes. Supports Markdown content, tags, folders, and pinning.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "The action to perform.",
        enum: [
          "create_note",
          "get_note",
          "update_note",
          "delete_note",
          "list_notes",
          "search_notes",
          "add_tag",
          "remove_tag",
          "toggle_pin",
          "move_to_folder",
        ],
      },
      title: {
        type: "string",
        description: "Note title for create_note and update_note.",
      },
      content: {
        type: "string",
        description:
          "Note content in Markdown format for create_note and update_note, including natural-language captures.",
      },
      noteId: {
        type: "string",
        description:
          "Note ID for get_note, update_note, delete_note, add_tag, remove_tag, toggle_pin, and move_to_folder.",
      },
      query: {
        type: "string",
        description: "Search keyword for search_notes.",
      },
      tag: {
        type: "string",
        description: "Tag value for add_tag, remove_tag, or list_notes filtering.",
      },
      tags: {
        type: "array",
        description: "List of tags for create_note or update_note.",
        items: {
          type: "string",
        },
      },
      folderId: {
        type: "string",
        description: "Folder ID for create_note, list_notes filtering, or move_to_folder.",
      },
      limit: {
        type: "number",
        description: "Maximum number of notes returned by list_notes or search_notes.",
      },
      sort: {
        type: "string",
        description: "Sort order for list_notes.",
        enum: ["updated", "created", "title"],
      },
      isPinned: {
        type: "boolean",
        description: "Pinned state for update_note.",
      },
    },
    required: ["action"],
  },
};

export const REMINDERS_DEFINITION: ToolDefinition = {
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

export const VOICE_DEFINITION: ToolDefinition = {
  name: "voice",
  description:
    "Manage conversation voice mode, including enabling voice, setting language, input mode, and checking current voice status.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "The action to perform.",
        enum: ["enable_voice", "disable_voice", "set_language", "set_input_mode", "get_voice_status"],
      },
      language: {
        type: "string",
        description: "Language code for speech recognition and text-to-speech, such as 'en-US'.",
      },
      mode: {
        type: "string",
        description: "Voice input mode.",
        enum: ["push-to-talk", "continuous"],
      },
    },
    required: ["action"],
  },
};

export const MEMORY_DEFINITION: ToolDefinition = {
  name: "memory",
  description:
    "Remember user details and recall relevant memories for better continuity across conversations.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description: "The action to perform.",
        enum: ["remember", "recall"],
      },
      content: {
        type: "string",
        description: "Memory content to persist when action is remember.",
      },
      tags: {
        type: "array",
        description: "Optional tags to attach to remembered content.",
        items: {
          type: "string",
        },
      },
      query: {
        type: "string",
        description: "Search query used when action is recall.",
      },
      limit: {
        type: "number",
        description: "Maximum number of recall results to return.",
      },
    },
    required: ["action"],
  },
};

export const BASH_DEFINITION: SystemToolDefinition = {
  name: "bash",
  description:
    "Execute shell commands within the project sandbox with timeout and safety checks.",
  input_schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute.",
      },
      workdir: {
        type: "string",
        description: "Optional working directory inside the project root.",
      },
      timeout: {
        type: "number",
        description: "Optional timeout in milliseconds. Defaults to the system limit.",
      },
    },
    required: ["command"],
  },
};

export const READ_DEFINITION: SystemToolDefinition = {
  name: "read",
  description:
    "Read a file from the project sandbox with optional offset and line limit.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to read.",
      },
      offset: {
        type: "number",
        description: "Optional starting line offset.",
      },
      limit: {
        type: "number",
        description: "Optional maximum number of lines to return.",
      },
    },
    required: ["path"],
  },
};

export const WRITE_DEFINITION: SystemToolDefinition = {
  name: "write",
  description:
    "Create or overwrite a file in the project sandbox, creating parent directories when allowed.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to write.",
      },
      content: {
        type: "string",
        description: "Full file content to write.",
      },
    },
    required: ["path", "content"],
  },
};

export const EDIT_DEFINITION: SystemToolDefinition = {
  name: "edit",
  description:
    "Replace an exact string match in a file and return a diff-style summary of the change.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Path to the file to edit.",
      },
      oldString: {
        type: "string",
        description: "Exact string to find in the file.",
      },
      newString: {
        type: "string",
        description: "Replacement string.",
      },
    },
    required: ["path", "oldString", "newString"],
  },
};

export const GLOB_DEFINITION: SystemToolDefinition = {
  name: "glob",
  description:
    "Find files matching a glob pattern under the project sandbox.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern to match files.",
      },
      path: {
        type: "string",
        description: "Optional base directory for the glob search.",
      },
    },
    required: ["pattern"],
  },
};

export const GREP_DEFINITION: SystemToolDefinition = {
  name: "grep",
  description:
    "Search file contents by regex pattern and return matching paths and line numbers.",
  input_schema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Regular expression pattern to search for.",
      },
      path: {
        type: "string",
        description: "Optional base directory to search in.",
      },
      include: {
        type: "string",
        description: "Optional file include pattern such as '*.ts'.",
      },
    },
    required: ["pattern"],
  },
};

export const LS_DEFINITION: SystemToolDefinition = {
  name: "ls",
  description:
    "List directory entries in the project sandbox, including metadata such as type and size.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Optional directory path to list. Defaults to current project root.",
      },
    },
  },
};

const SYSTEM_TOOL_DEFINITIONS: SystemToolDefinition[] = [
  BASH_DEFINITION,
  READ_DEFINITION,
  WRITE_DEFINITION,
  EDIT_DEFINITION,
  GLOB_DEFINITION,
  GREP_DEFINITION,
  LS_DEFINITION,
];

function toToolDefinition(definition: SystemToolDefinition): ToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.input_schema,
  };
}

export function getBuiltinSystemToolDefinitions(): SystemToolDefinition[] {
  return [...SYSTEM_TOOL_DEFINITIONS];
}

/**
 * Returns all built-in tool definitions for provider API calls.
 */
export function getBuiltinToolDefinitions(): ToolDefinition[] {
  return [
    CALENDAR_DEFINITION,
    NOTES_DEFINITION,
    REMINDERS_DEFINITION,
    VOICE_DEFINITION,
    MEMORY_DEFINITION,
    ...SYSTEM_TOOL_DEFINITIONS.map(toToolDefinition),
  ];
}
