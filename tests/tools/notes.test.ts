import { describe, expect, it } from "bun:test";

import { NotesTool, ToolRegistry, type NoteBackendClient, type NoteData } from "../../src/tools";
import type { ToolContext } from "../../src/types";

const toolContext: ToolContext = {
  conversationId: "conv-123",
  userId: "user-123",
  workspaceId: "ws-123",
};

describe("NotesTool", () => {
  it("registers in ToolRegistry and exposes definition", () => {
    const tool = new NotesTool(createMockBackendClient());
    const registry = new ToolRegistry();

    registry.register(tool);

    const definition = registry.getDefinitions()[0];
    expect(definition?.name).toBe("notes");
    expect(definition?.parameters.required).toEqual(["action"]);
  });

  it("creates notes with Markdown content", async () => {
    let capturedTitle: string | undefined;
    let capturedContent: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async createNote(params) {
          capturedTitle = params.title;
          capturedContent = params.content;
          return buildNote({ id: "note-1", title: params.title, content: params.content, tags: params.tags ?? [] });
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-create",
        action: "create_note",
        title: "Meeting notes",
        content: "# Weekly Sync\n- Review roadmap\n- Assign tasks",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; note: NoteData };
    expect(payload.action).toBe("create_note");
    expect(payload.note.id).toBe("note-1");
    expect(capturedTitle).toBe("Meeting notes");
    expect(capturedContent).toContain("# Weekly Sync");
  });

  it("creates notes with tags and folder", async () => {
    let capturedTags: string[] | undefined;
    let capturedFolderId: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async createNote(params) {
          capturedTags = params.tags;
          capturedFolderId = params.folderId;
          return buildNote({
            id: "note-2",
            title: params.title,
            content: params.content,
            tags: params.tags ?? [],
            folderId: params.folderId,
          });
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-create-folder",
        action: "create_note",
        title: "Project ideas",
        content: "Capture ideas for Q2",
        tags: ["ideas", "q2"],
        folderId: "folder-strategy",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    const payload = result.result as { action: string; note: NoteData };
    expect(payload.note.folderId).toBe("folder-strategy");
    expect(payload.note.tags).toEqual(["ideas", "q2"]);
    expect(capturedTags).toEqual(["ideas", "q2"]);
    expect(capturedFolderId).toBe("folder-strategy");
  });

  it("gets a note by id", async () => {
    let capturedNoteId: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async getNote(params) {
          capturedNoteId = params.noteId;
          return buildNote({ id: params.noteId, title: "Stored note" });
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-get",
        action: "get_note",
        noteId: "note-get",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedNoteId).toBe("note-get");
    const payload = result.result as { action: string; note: NoteData };
    expect(payload.action).toBe("get_note");
    expect(payload.note.id).toBe("note-get");
  });

  it("updates a note title only", async () => {
    let capturedTitle: string | undefined;
    let capturedContent: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async updateNote(params) {
          capturedTitle = params.title;
          capturedContent = params.content;
          return buildNote({ id: params.noteId, title: params.title ?? "unchanged" });
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-update-title",
        action: "update_note",
        noteId: "note-up-1",
        title: "Renamed note",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedTitle).toBe("Renamed note");
    expect(capturedContent).toBeUndefined();
    const payload = result.result as { action: string; note: NoteData };
    expect(payload.note.title).toBe("Renamed note");
  });

  it("updates note content only", async () => {
    let capturedTitle: string | undefined;
    let capturedContent: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async updateNote(params) {
          capturedTitle = params.title;
          capturedContent = params.content;
          return buildNote({ id: params.noteId, content: params.content ?? "" });
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-update-content",
        action: "update_note",
        noteId: "note-up-2",
        content: "Updated markdown body",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedTitle).toBeUndefined();
    expect(capturedContent).toBe("Updated markdown body");
    const payload = result.result as { action: string; note: NoteData };
    expect(payload.note.content).toBe("Updated markdown body");
  });

  it("updates note tags only", async () => {
    let capturedTags: string[] | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async updateNote(params) {
          capturedTags = params.tags;
          return buildNote({ id: params.noteId, tags: params.tags ?? [] });
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-update-tags",
        action: "update_note",
        noteId: "note-up-3",
        tags: ["planning", "work"],
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedTags).toEqual(["planning", "work"]);
    const payload = result.result as { action: string; note: NoteData };
    expect(payload.note.tags).toEqual(["planning", "work"]);
  });

  it("deletes a note", async () => {
    let deletedNoteId: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async deleteNote(params) {
          deletedNoteId = params.noteId;
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-delete",
        action: "delete_note",
        noteId: "note-delete",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(deletedNoteId).toBe("note-delete");
    expect(result.result).toEqual({ action: "delete_note", noteId: "note-delete", success: true });
  });

  it("lists notes with default options", async () => {
    let capturedLimit: number | undefined;
    let capturedSort: string | undefined;
    let capturedFolderId: string | undefined;
    let capturedTag: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async listNotes(params) {
          capturedLimit = params.limit;
          capturedSort = params.sort;
          capturedFolderId = params.folderId;
          capturedTag = params.tag;
          return [buildNote({ id: "note-list-1", title: "A" }), buildNote({ id: "note-list-2", title: "B" })];
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-list-default",
        action: "list_notes",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedLimit).toBeUndefined();
    expect(capturedSort).toBeUndefined();
    expect(capturedFolderId).toBeUndefined();
    expect(capturedTag).toBeUndefined();
    const payload = result.result as { action: string; count: number; notes: NoteData[] };
    expect(payload.action).toBe("list_notes");
    expect(payload.count).toBe(2);
  });

  it("lists notes with folder and tag filters plus sort and limit", async () => {
    let capturedLimit: number | undefined;
    let capturedSort: string | undefined;
    let capturedFolderId: string | undefined;
    let capturedTag: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async listNotes(params) {
          capturedLimit = params.limit;
          capturedSort = params.sort;
          capturedFolderId = params.folderId;
          capturedTag = params.tag;
          return [buildNote({ id: "note-list-filtered", title: "Filtered" })];
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-list-filtered",
        action: "list_notes",
        folderId: "folder-project",
        tag: "work",
        sort: "updated",
        limit: 3,
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedFolderId).toBe("folder-project");
    expect(capturedTag).toBe("work");
    expect(capturedSort).toBe("updated");
    expect(capturedLimit).toBe(3);
    const payload = result.result as { action: string; count: number; notes: NoteData[] };
    expect(payload.count).toBe(1);
  });

  it("searches notes by keyword", async () => {
    let capturedQuery: string | undefined;
    let capturedLimit: number | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async searchNotes(params) {
          capturedQuery = params.query;
          capturedLimit = params.limit;
          return [buildNote({ id: "note-search-1", title: "Trip planning", content: "Book flights" })];
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-search",
        action: "search_notes",
        query: "trip",
        limit: 5,
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedQuery).toBe("trip");
    expect(capturedLimit).toBe(5);
    const payload = result.result as { action: string; query: string; count: number; notes: NoteData[] };
    expect(payload.action).toBe("search_notes");
    expect(payload.query).toBe("trip");
    expect(payload.count).toBe(1);
  });

  it("adds and removes tags", async () => {
    let addCapturedTag: string | undefined;
    let removeCapturedTag: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async addTag(params) {
          addCapturedTag = params.tag;
          return buildNote({ id: params.noteId, tags: ["initial", params.tag] });
        },
        async removeTag(params) {
          removeCapturedTag = params.tag;
          return buildNote({ id: params.noteId, tags: ["initial"] });
        },
      }),
    );

    const addResult = await tool.execute(
      {
        callId: "call-add-tag",
        action: "add_tag",
        noteId: "note-tag-1",
        tag: "ideas",
      },
      toolContext,
    );
    expect(addResult.error).toBeUndefined();
    expect(addCapturedTag).toBe("ideas");

    const removeResult = await tool.execute(
      {
        callId: "call-remove-tag",
        action: "remove_tag",
        noteId: "note-tag-1",
        tag: "ideas",
      },
      toolContext,
    );
    expect(removeResult.error).toBeUndefined();
    expect(removeCapturedTag).toBe("ideas");
  });

  it("toggles pin state", async () => {
    let capturedNoteId: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async togglePin(params) {
          capturedNoteId = params.noteId;
          return buildNote({ id: params.noteId, isPinned: true });
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-toggle-pin",
        action: "toggle_pin",
        noteId: "note-pin-1",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedNoteId).toBe("note-pin-1");
    const payload = result.result as { action: string; note: NoteData };
    expect(payload.note.isPinned).toBe(true);
  });

  it("moves note to folder", async () => {
    let capturedNoteId: string | undefined;
    let capturedFolderId: string | undefined;

    const tool = new NotesTool(
      createMockBackendClient({
        async moveToFolder(params) {
          capturedNoteId = params.noteId;
          capturedFolderId = params.folderId;
          return buildNote({ id: params.noteId, folderId: params.folderId });
        },
      }),
    );

    const result = await tool.execute(
      {
        callId: "call-move-folder",
        action: "move_to_folder",
        noteId: "note-move-1",
        folderId: "folder-archive",
      },
      toolContext,
    );

    expect(result.error).toBeUndefined();
    expect(capturedNoteId).toBe("note-move-1");
    expect(capturedFolderId).toBe("folder-archive");
    const payload = result.result as { action: string; note: NoteData };
    expect(payload.note.folderId).toBe("folder-archive");
  });

  it("returns an error for invalid actions", async () => {
    const tool = new NotesTool(createMockBackendClient());

    const result = await tool.execute(
      {
        callId: "call-invalid",
        action: "rename_note",
      },
      toolContext,
    );

    expect(result.error).toBe("Missing or invalid 'action' argument.");
  });

  it("returns validation errors for missing required create params", async () => {
    const tool = new NotesTool(createMockBackendClient());

    const missingTitle = await tool.execute(
      {
        action: "create_note",
        content: "Body",
      },
      toolContext,
    );
    expect(missingTitle.error).toBe("'title' is required for create_note action.");

    const missingContent = await tool.execute(
      {
        action: "create_note",
        title: "Title",
      },
      toolContext,
    );
    expect(missingContent.error).toBe("'content' is required for create_note action.");
  });

  it("returns backend client errors", async () => {
    const tool = new NotesTool(
      createMockBackendClient({
        async searchNotes() {
          throw new Error("Backend unavailable");
        },
      }),
    );

    const result = await tool.execute(
      {
        action: "search_notes",
        query: "important",
      },
      toolContext,
    );

    expect(result.error).toBe("Backend unavailable");
    expect(result.result).toBeNull();
  });

  it("returns validation errors when noteId is missing for noteId actions", async () => {
    const tool = new NotesTool(createMockBackendClient());

    const actions: Array<{ action: string; message: string }> = [
      { action: "get_note", message: "'noteId' is required for get_note action." },
      { action: "update_note", message: "'noteId' is required for update_note action." },
      { action: "delete_note", message: "'noteId' is required for delete_note action." },
      { action: "add_tag", message: "'noteId' is required for add_tag action." },
      { action: "remove_tag", message: "'noteId' is required for remove_tag action." },
      { action: "toggle_pin", message: "'noteId' is required for toggle_pin action." },
      { action: "move_to_folder", message: "'noteId' is required for move_to_folder action." },
    ];

    for (const testCase of actions) {
      const result = await tool.execute({ action: testCase.action }, toolContext);
      expect(result.error).toBe(testCase.message);
    }
  });
});

function createMockBackendClient(overrides?: Partial<NoteBackendClient>): NoteBackendClient {
  return {
    async createNote(params) {
      if (overrides?.createNote) {
        return overrides.createNote(params);
      }

      return buildNote({
        id: "note-default-create",
        title: params.title,
        content: params.content,
        tags: params.tags ?? [],
        folderId: params.folderId,
      });
    },
    async getNote(params) {
      if (overrides?.getNote) {
        return overrides.getNote(params);
      }

      return buildNote({ id: params.noteId, title: "Fetched note" });
    },
    async updateNote(params) {
      if (overrides?.updateNote) {
        return overrides.updateNote(params);
      }

      return buildNote({
        id: params.noteId,
        title: params.title ?? "Updated note",
        content: params.content ?? "Existing content",
        tags: params.tags ?? ["default"],
        folderId: params.folderId,
        isPinned: params.isPinned ?? false,
      });
    },
    async deleteNote(params) {
      if (overrides?.deleteNote) {
        return overrides.deleteNote(params);
      }
    },
    async listNotes(params) {
      if (overrides?.listNotes) {
        return overrides.listNotes(params);
      }

      return [
        buildNote({ id: "note-list-default", folderId: params.folderId, tags: params.tag ? [params.tag] : [] }),
      ];
    },
    async searchNotes(params) {
      if (overrides?.searchNotes) {
        return overrides.searchNotes(params);
      }

      return [buildNote({ id: "note-search-default", title: `Result for ${params.query}` })];
    },
    async addTag(params) {
      if (overrides?.addTag) {
        return overrides.addTag(params);
      }

      return buildNote({ id: params.noteId, tags: [params.tag] });
    },
    async removeTag(params) {
      if (overrides?.removeTag) {
        return overrides.removeTag(params);
      }

      return buildNote({ id: params.noteId, tags: [] });
    },
    async togglePin(params) {
      if (overrides?.togglePin) {
        return overrides.togglePin(params);
      }

      return buildNote({ id: params.noteId, isPinned: true });
    },
    async moveToFolder(params) {
      if (overrides?.moveToFolder) {
        return overrides.moveToFolder(params);
      }

      return buildNote({ id: params.noteId, folderId: params.folderId });
    },
  };
}

function buildNote(overrides?: Partial<NoteData>): NoteData {
  const now = new Date().toISOString();

  return {
    id: overrides?.id ?? "note-default",
    title: overrides?.title ?? "Untitled",
    content: overrides?.content ?? "",
    tags: overrides?.tags ?? [],
    folderId: overrides?.folderId,
    folderName: overrides?.folderName,
    isPinned: overrides?.isPinned ?? false,
    wordCount: overrides?.wordCount ?? 0,
    linkedNoteIds: overrides?.linkedNoteIds,
    createdAt: overrides?.createdAt ?? now,
    updatedAt: overrides?.updatedAt ?? now,
  };
}
