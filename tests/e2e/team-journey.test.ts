import { describe, expect, it } from "bun:test";

import { ConversationManager, InMemoryConversationStore } from "../../src/conversation";
import { NotesTool, type NoteBackendClient } from "../../src/tools";

interface Team {
  id: string;
  name: string;
  members: string[];
  sharedModel: string;
}

class InMemoryTeamService {
  private readonly teams = new Map<string, Team>();

  createTeam(name: string, ownerId: string): Team {
    const team: Team = {
      id: `team-${this.teams.size + 1}`,
      name,
      members: [ownerId],
      sharedModel: "gpt-4o-mini",
    };
    this.teams.set(team.id, team);
    return team;
  }

  inviteMember(teamId: string, memberId: string): void {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }
    if (!team.members.includes(memberId)) {
      team.members.push(memberId);
    }
  }

  setSharedModel(teamId: string, model: string): void {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }
    team.sharedModel = model;
  }

  getTeam(teamId: string): Team {
    const team = this.teams.get(teamId);
    if (!team) {
      throw new Error(`Team not found: ${teamId}`);
    }
    return team;
  }
}

function createTeamScopedNotesBackend(): NoteBackendClient {
  return {
    async createNote(params) {
      return {
        id: "team-note-1",
        title: params.title,
        content: params.content,
        tags: params.tags ?? [],
        folderId: params.folderId,
        folderName: params.workspaceId ? `workspace-${params.workspaceId}` : undefined,
        isPinned: false,
        wordCount: params.content.split(/\s+/).length,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      };
    },
    async getNote(params) {
      return {
        id: params.noteId,
        title: "Team note",
        content: "Shared content",
        tags: ["team"],
        isPinned: false,
        wordCount: 2,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:00:00.000Z",
      };
    },
    async updateNote(params) {
      return {
        id: params.noteId,
        title: params.title ?? "Team note",
        content: params.content ?? "Shared content",
        tags: params.tags ?? ["team"],
        folderId: params.folderId,
        isPinned: params.isPinned ?? false,
        wordCount: 2,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:10:00.000Z",
      };
    },
    async deleteNote() {},
    async listNotes() {
      return [];
    },
    async searchNotes() {
      return [];
    },
    async addTag(params) {
      return {
        id: params.noteId,
        title: "Team note",
        content: "Shared content",
        tags: ["team", params.tag],
        isPinned: false,
        wordCount: 2,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:10:00.000Z",
      };
    },
    async removeTag(params) {
      return {
        id: params.noteId,
        title: "Team note",
        content: "Shared content",
        tags: ["team"],
        isPinned: false,
        wordCount: 2,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:10:00.000Z",
      };
    },
    async togglePin(params) {
      return {
        id: params.noteId,
        title: "Team note",
        content: "Shared content",
        tags: ["team"],
        isPinned: true,
        wordCount: 2,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:10:00.000Z",
      };
    },
    async moveToFolder(params) {
      return {
        id: params.noteId,
        title: "Team note",
        content: "Shared content",
        tags: ["team"],
        folderId: params.folderId,
        isPinned: false,
        wordCount: 2,
        createdAt: "2026-03-01T00:00:00.000Z",
        updatedAt: "2026-03-01T00:10:00.000Z",
      };
    },
  };
}

describe("e2e/team-journey", () => {
  it("covers team creation, invitation, shared config, and team-scoped data", async () => {
    const teamService = new InMemoryTeamService();
    const team = teamService.createTeam("Product", "owner-1");
    expect(team.members).toEqual(["owner-1"]);

    teamService.inviteMember(team.id, "member-2");
    const invited = teamService.getTeam(team.id);
    expect(invited.members).toEqual(["owner-1", "member-2"]);

    teamService.setSharedModel(team.id, "claude-3-5-sonnet-latest");
    const configured = teamService.getTeam(team.id);
    expect(configured.sharedModel).toBe("claude-3-5-sonnet-latest");

    const conversationStore = new InMemoryConversationStore();
    const manager = new ConversationManager(conversationStore);
    const conversation = await manager.create({
      title: "Team conversation",
      model: configured.sharedModel,
      provider: "gateway",
      workspaceId: team.id,
    });
    await manager.addMessage(conversation.id, {
      role: "user",
      content: "Prepare team launch checklist",
    });

    const loaded = await manager.load(conversation.id);
    expect(loaded.workspaceId).toBe(team.id);
    expect(loaded.model).toBe("claude-3-5-sonnet-latest");

    const notesTool = new NotesTool(createTeamScopedNotesBackend());
    const noteResult = await notesTool.execute(
      {
        callId: "team-note-call",
        action: "create_note",
        title: "Launch checklist",
        content: "- finalize copy\n- validate analytics",
        tags: ["team", "launch"],
      },
      {
        conversationId: conversation.id,
        userId: "owner-1",
        workspaceId: team.id,
      },
    );

    const payload = noteResult.result as {
      action: string;
      note: { title: string; tags: string[]; folderName?: string };
    };
    expect(payload.action).toBe("create_note");
    expect(payload.note.title).toBe("Launch checklist");
    expect(payload.note.tags).toContain("team");
    expect(payload.note.folderName).toBe(`workspace-${team.id}`);
  });
});
