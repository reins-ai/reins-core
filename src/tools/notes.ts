import type { Tool, ToolContext, ToolDefinition, ToolResult } from "../types";

type NotesAction =
  | "create_note"
  | "get_note"
  | "update_note"
  | "delete_note"
  | "list_notes"
  | "search_notes"
  | "add_tag"
  | "remove_tag"
  | "toggle_pin"
  | "move_to_folder";

type ListSort = "updated" | "created" | "title";

export interface NoteData {
  id: string;
  title: string;
  content: string;
  tags: string[];
  folderId?: string;
  folderName?: string;
  isPinned: boolean;
  wordCount: number;
  linkedNoteIds?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateNoteParams {
  title: string;
  content: string;
  tags?: string[];
  folderId?: string;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface GetNoteParams {
  noteId: string;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface UpdateNoteParams {
  noteId: string;
  title?: string;
  content?: string;
  tags?: string[];
  folderId?: string;
  isPinned?: boolean;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface DeleteNoteParams {
  noteId: string;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface ListNotesParams {
  folderId?: string;
  tag?: string;
  limit?: number;
  sort?: ListSort;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface SearchNotesParams {
  query: string;
  limit?: number;
  conversationId: string;
  userId: string;
  workspaceId?: string;
}

export interface NoteBackendClient {
  createNote(params: CreateNoteParams): Promise<NoteData>;
  getNote(params: GetNoteParams): Promise<NoteData>;
  updateNote(params: UpdateNoteParams): Promise<NoteData>;
  deleteNote(params: DeleteNoteParams): Promise<void>;
  listNotes(params: ListNotesParams): Promise<NoteData[]>;
  searchNotes(params: SearchNotesParams): Promise<NoteData[]>;
  addTag(params: { noteId: string; tag: string; userId: string }): Promise<NoteData>;
  removeTag(params: { noteId: string; tag: string; userId: string }): Promise<NoteData>;
  togglePin(params: { noteId: string; userId: string }): Promise<NoteData>;
  moveToFolder(params: { noteId: string; folderId?: string; userId: string }): Promise<NoteData>;
}

export class NotesTool implements Tool {
  definition: ToolDefinition = {
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

  constructor(private readonly backendClient: NoteBackendClient) {}

  async execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const callId = this.readString(args.callId) ?? "unknown-call";
    const action = this.normalizeAction(args.action);

    if (!action) {
      return this.errorResult(callId, "Missing or invalid 'action' argument.");
    }

    try {
      switch (action) {
        case "create_note":
          return await this.createNote(callId, args, context);
        case "get_note":
          return await this.getNote(callId, args, context);
        case "update_note":
          return await this.updateNote(callId, args, context);
        case "delete_note":
          return await this.deleteNote(callId, args, context);
        case "list_notes":
          return await this.listNotes(callId, args, context);
        case "search_notes":
          return await this.searchNotes(callId, args, context);
        case "add_tag":
          return await this.addTag(callId, args, context);
        case "remove_tag":
          return await this.removeTag(callId, args, context);
        case "toggle_pin":
          return await this.togglePin(callId, args, context);
        case "move_to_folder":
          return await this.moveToFolder(callId, args, context);
      }
    } catch (error) {
      return this.errorResult(callId, this.formatError(error));
    }
  }

  private async createNote(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const title = this.requireString(args.title, "'title' is required for create_note action.");
    const content = this.requireString(args.content, "'content' is required for create_note action.");
    const tags = this.optionalStringArray(args.tags, "'tags' must be an array of non-empty strings.");
    const folderId = this.optionalString(args.folderId);

    const note = await this.backendClient.createNote({
      title,
      content,
      tags,
      folderId,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "create_note",
      note,
    });
  }

  private async getNote(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const noteId = this.requireString(args.noteId, "'noteId' is required for get_note action.");

    const note = await this.backendClient.getNote({
      noteId,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "get_note",
      note,
    });
  }

  private async updateNote(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const noteId = this.requireString(args.noteId, "'noteId' is required for update_note action.");
    const title = this.optionalString(args.title);
    const content = this.optionalString(args.content);
    const tags = this.optionalStringArray(args.tags, "'tags' must be an array of non-empty strings.");
    const folderId = this.optionalString(args.folderId);
    const isPinned = this.optionalBoolean(args.isPinned, "'isPinned' must be a boolean.");

    if (!title && !content && !tags && !folderId && isPinned === undefined) {
      throw new Error("At least one field must be provided for update_note action.");
    }

    const note = await this.backendClient.updateNote({
      noteId,
      title,
      content,
      tags,
      folderId,
      isPinned,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "update_note",
      note,
    });
  }

  private async deleteNote(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const noteId = this.requireString(args.noteId, "'noteId' is required for delete_note action.");

    await this.backendClient.deleteNote({
      noteId,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "delete_note",
      noteId,
      success: true,
    });
  }

  private async listNotes(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const folderId = this.optionalString(args.folderId);
    const tag = this.optionalString(args.tag);
    const limit = this.optionalPositiveInteger(args.limit, "'limit' must be a positive integer.");
    const sort = this.optionalSort(args.sort);

    const notes = await this.backendClient.listNotes({
      folderId,
      tag,
      limit,
      sort,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "list_notes",
      notes,
      count: notes.length,
    });
  }

  private async searchNotes(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const query = this.requireString(args.query, "'query' is required for search_notes action.");
    const limit = this.optionalPositiveInteger(args.limit, "'limit' must be a positive integer.");

    const notes = await this.backendClient.searchNotes({
      query,
      limit,
      conversationId: context.conversationId,
      userId: context.userId,
      workspaceId: context.workspaceId,
    });

    return this.successResult(callId, {
      action: "search_notes",
      query,
      notes,
      count: notes.length,
    });
  }

  private async addTag(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const noteId = this.requireString(args.noteId, "'noteId' is required for add_tag action.");
    const tag = this.requireString(args.tag, "'tag' is required for add_tag action.");

    const note = await this.backendClient.addTag({
      noteId,
      tag,
      userId: context.userId,
    });

    return this.successResult(callId, {
      action: "add_tag",
      note,
    });
  }

  private async removeTag(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const noteId = this.requireString(args.noteId, "'noteId' is required for remove_tag action.");
    const tag = this.requireString(args.tag, "'tag' is required for remove_tag action.");

    const note = await this.backendClient.removeTag({
      noteId,
      tag,
      userId: context.userId,
    });

    return this.successResult(callId, {
      action: "remove_tag",
      note,
    });
  }

  private async togglePin(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const noteId = this.requireString(args.noteId, "'noteId' is required for toggle_pin action.");

    const note = await this.backendClient.togglePin({
      noteId,
      userId: context.userId,
    });

    return this.successResult(callId, {
      action: "toggle_pin",
      note,
    });
  }

  private async moveToFolder(
    callId: string,
    args: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolResult> {
    const noteId = this.requireString(args.noteId, "'noteId' is required for move_to_folder action.");
    const folderId = this.optionalString(args.folderId);

    const note = await this.backendClient.moveToFolder({
      noteId,
      folderId,
      userId: context.userId,
    });

    return this.successResult(callId, {
      action: "move_to_folder",
      note,
    });
  }

  private normalizeAction(value: unknown): NotesAction | null {
    const action = this.readString(value);
    if (!action) {
      return null;
    }

    if (
      action === "create_note" ||
      action === "get_note" ||
      action === "update_note" ||
      action === "delete_note" ||
      action === "list_notes" ||
      action === "search_notes" ||
      action === "add_tag" ||
      action === "remove_tag" ||
      action === "toggle_pin" ||
      action === "move_to_folder"
    ) {
      return action;
    }

    return null;
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

  private optionalStringArray(value: unknown, message: string): string[] | undefined {
    if (value === undefined) {
      return undefined;
    }

    if (!Array.isArray(value)) {
      throw new Error(message);
    }

    const normalized: string[] = [];
    for (const item of value) {
      if (typeof item !== "string") {
        throw new Error(message);
      }

      const trimmed = item.trim();
      if (trimmed.length === 0) {
        throw new Error(message);
      }

      normalized.push(trimmed);
    }

    return normalized;
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

  private optionalSort(value: unknown): ListSort | undefined {
    if (value === undefined) {
      return undefined;
    }

    const sort = this.readString(value);
    if (!sort) {
      throw new Error("'sort' must be one of: updated, created, title.");
    }

    if (sort === "updated" || sort === "created" || sort === "title") {
      return sort;
    }

    throw new Error("'sort' must be one of: updated, created, title.");
  }

  private formatError(error: unknown): string {
    if (error instanceof Error && error.message.trim().length > 0) {
      return error.message;
    }

    if (typeof error === "string" && error.trim().length > 0) {
      return error;
    }

    return "Notes tool execution failed.";
  }
}
