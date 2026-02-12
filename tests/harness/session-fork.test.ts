import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ConversationManager,
  InMemoryConversationStore,
  SessionRepository,
  createHarnessEventBus,
  SessionStore,
} from "../../src";

interface TestContext {
  homeDirectory: string;
  sessionRepository: SessionRepository;
  conversationManager: ConversationManager;
  sessionStore: SessionStore;
}

const temporaryDirectories: string[] = [];

async function createContext(): Promise<TestContext> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "reins-harness-session-fork-"));
  temporaryDirectories.push(homeDirectory);

  const daemonPathOptions = {
    platform: "linux" as const,
    env: {},
    homeDirectory,
  };

  const sessionRepository = new SessionRepository({
    daemonPathOptions,
    defaultModel: "claude-sonnet-4-20250514",
    defaultProvider: "anthropic",
  });

  const conversationManager = new ConversationManager(new InMemoryConversationStore(), sessionRepository);
  const sessionStore = new SessionStore({
    eventBus: createHarnessEventBus(),
    sessionRepository,
    conversationManager,
  });

  return {
    homeDirectory,
    sessionRepository,
    conversationManager,
    sessionStore,
  };
}

describe("SessionStore fork", () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (!directory) {
        continue;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  it("forks the active session with lineage metadata", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    const parentId = restored.value.session.id;

    const forked = await context.sessionStore.forkSession({
      title: "Forked Branch",
      turnIndex: 5,
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok) {
      return;
    }

    expect(forked.value.id).not.toBe(parentId);
    expect(forked.value.title).toBe("Forked Branch");
    expect(forked.value.parentSessionId).toBe(parentId);
    expect(forked.value.forkTurnIndex).toBe(5);
    expect(forked.value.status).toBe("active");
    expect(forked.value.model).toBe("claude-sonnet-4-20250514");
    expect(forked.value.provider).toBe("anthropic");
  });

  it("uses default title when no title is provided", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    const forked = await context.sessionStore.forkSession();
    expect(forked.ok).toBe(true);
    if (!forked.ok) {
      return;
    }

    expect(forked.value.title).toBe(`${restored.value.session.title} (Fork)`);
  });

  it("defaults turnIndex to parent messageCount when not specified", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    // Update the parent session's message count through the repository
    // to simulate messages being added to the session
    const parentId = restored.value.session.id;
    await context.sessionRepository.update(parentId, { messageCount: 12 });

    // Re-restore to pick up the updated messageCount in the active session
    const refreshed = await context.sessionStore.restore(parentId);
    expect(refreshed.ok).toBe(true);
    if (!refreshed.ok) {
      return;
    }

    const forked = await context.sessionStore.forkSession();
    expect(forked.ok).toBe(true);
    if (!forked.ok) {
      return;
    }

    // Default turnIndex should be the parent's messageCount
    expect(forked.value.forkTurnIndex).toBe(12);
  });

  it("returns error when forking without an active session", async () => {
    const context = await createContext();

    // Don't restore — no active session
    const forked = await context.sessionStore.forkSession();
    expect(forked.ok).toBe(false);
    if (!forked.ok) {
      expect(forked.error.message).toContain("No active session to fork");
    }
  });

  it("forked session is independent from parent", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    const parentId = restored.value.session.id;

    const forked = await context.sessionStore.forkSession({
      title: "Independent Branch",
      turnIndex: 3,
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok) {
      return;
    }

    // Update the forked session independently
    const updateResult = await context.sessionRepository.update(forked.value.id, {
      title: "Modified Fork",
      messageCount: 10,
    });
    expect(updateResult.ok).toBe(true);

    // Verify parent is unchanged
    const parentResult = await context.sessionRepository.get(parentId);
    expect(parentResult.ok).toBe(true);
    if (!parentResult.ok) {
      return;
    }

    expect(parentResult.value).not.toBeNull();
    expect(parentResult.value!.title).not.toBe("Modified Fork");
    expect(parentResult.value!.messageCount).toBe(0);

    // Verify fork was updated
    const forkResult = await context.sessionRepository.get(forked.value.id);
    expect(forkResult.ok).toBe(true);
    if (!forkResult.ok) {
      return;
    }

    expect(forkResult.value).not.toBeNull();
    expect(forkResult.value!.title).toBe("Modified Fork");
    expect(forkResult.value!.messageCount).toBe(10);
  });

  it("forked session persists lineage across repository restart", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    const parentId = restored.value.session.id;

    const forked = await context.sessionStore.forkSession({
      title: "Persistent Fork",
      turnIndex: 7,
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok) {
      return;
    }

    // Restart the repository from disk
    const restartedRepository = new SessionRepository({
      daemonPathOptions: {
        platform: "linux",
        env: {},
        homeDirectory: context.homeDirectory,
      },
      defaultModel: "claude-sonnet-4-20250514",
      defaultProvider: "anthropic",
    });

    const reloaded = await restartedRepository.get(forked.value.id);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) {
      return;
    }

    expect(reloaded.value).not.toBeNull();
    expect(reloaded.value!.parentSessionId).toBe(parentId);
    expect(reloaded.value!.forkTurnIndex).toBe(7);
    expect(reloaded.value!.title).toBe("Persistent Fork");
  });

  it("can fork multiple times from the same parent", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    const parentId = restored.value.session.id;

    const fork1 = await context.sessionStore.forkSession({
      title: "Fork A",
      turnIndex: 2,
    });
    expect(fork1.ok).toBe(true);
    if (!fork1.ok) {
      return;
    }

    const fork2 = await context.sessionStore.forkSession({
      title: "Fork B",
      turnIndex: 5,
    });
    expect(fork2.ok).toBe(true);
    if (!fork2.ok) {
      return;
    }

    expect(fork1.value.id).not.toBe(fork2.value.id);
    expect(fork1.value.parentSessionId).toBe(parentId);
    expect(fork2.value.parentSessionId).toBe(parentId);
    expect(fork1.value.forkTurnIndex).toBe(2);
    expect(fork2.value.forkTurnIndex).toBe(5);

    // All three sessions should exist
    const listed = await context.sessionRepository.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }

    expect(listed.value.length).toBe(3);
  });

  it("forked session does not become main", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    const forked = await context.sessionStore.forkSession({
      title: "Side Branch",
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok) {
      return;
    }

    expect(forked.value.isMain).toBe(false);

    // Main should still be the original
    const main = await context.sessionRepository.getMain();
    expect(main.ok).toBe(true);
    if (!main.ok) {
      return;
    }

    expect(main.value.id).toBe(restored.value.session.id);
  });
});

describe("SessionStore restore", () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (!directory) {
        continue;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restore returns session metadata and messages array", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    expect(restored.value.session).toBeDefined();
    expect(restored.value.session.id).toBeDefined();
    expect(Array.isArray(restored.value.messages)).toBe(true);
  });

  it("restore by specific session id returns that session", async () => {
    const context = await createContext();

    // Create a second session
    const created = await context.sessionRepository.create({
      title: "Specific Session",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }

    const restored = await context.sessionStore.restore(created.value.id);
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    expect(restored.value.session.id).toBe(created.value.id);
    expect(restored.value.session.title).toBe("Specific Session");
  });

  it("restore sets the active session for subsequent operations", async () => {
    const context = await createContext();

    expect(context.sessionStore.getActiveSession()).toBeNull();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);

    const active = context.sessionStore.getActiveSession();
    expect(active).not.toBeNull();
    expect(active!.id).toBeDefined();
  });

  it("restore returns error for non-existent session id", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore("nonexistent-id");
    expect(restored.ok).toBe(false);
    if (!restored.ok) {
      expect(restored.error.message).toContain("Session not found");
    }
  });
});
