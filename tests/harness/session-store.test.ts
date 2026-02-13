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
  const homeDirectory = await mkdtemp(join(tmpdir(), "reins-harness-session-store-"));
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

describe("SessionStore", () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (!directory) {
        continue;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores and persists sessions across repository restart", async () => {
    const context = await createContext();

    const initialMain = await context.sessionStore.restore();
    expect(initialMain.ok).toBe(true);
    if (!initialMain.ok) {
      return;
    }

    const started = await context.conversationManager.startNewSession({
      title: "Branch A",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    const restored = await context.sessionStore.restore(started.value.id);
    expect(restored.ok).toBe(true);
    if (!restored.ok) {
      return;
    }

    const persisted = await context.sessionStore.persist();
    expect(persisted.ok).toBe(true);
    if (!persisted.ok) {
      return;
    }

    const restartedRepository = new SessionRepository({
      daemonPathOptions: {
        platform: "linux",
        env: {},
        homeDirectory: context.homeDirectory,
      },
      defaultModel: "claude-sonnet-4-20250514",
      defaultProvider: "anthropic",
    });
    const restartedManager = new ConversationManager(new InMemoryConversationStore(), restartedRepository);
    const restartedStore = new SessionStore({
      eventBus: createHarnessEventBus(),
      sessionRepository: restartedRepository,
      conversationManager: restartedManager,
    });

    const reloaded = await restartedStore.restore(started.value.id);
    expect(reloaded.ok).toBe(true);
    if (!reloaded.ok) {
      return;
    }

    expect(reloaded.value.session.id).toBe(started.value.id);
    expect(reloaded.value.session.title).toBe("Branch A");
    expect(reloaded.value.session.id).not.toBe(initialMain.value.session.id);
  });

  it("emits aborted events and propagates turn cancellation state", async () => {
    const context = await createContext();
    const events: Array<{ initiatedBy: "user" | "system"; reason?: string }> = [];

    const bus = createHarnessEventBus();
    bus.on("aborted", (event) => {
      events.push(event.payload);
    });

    const store = new SessionStore({
      eventBus: bus,
      sessionRepository: context.sessionRepository,
      conversationManager: context.conversationManager,
    });

    const signalResult = store.startTurn();
    expect(signalResult.ok).toBe(true);
    if (!signalResult.ok) {
      return;
    }

    expect(signalResult.value.aborted).toBe(false);
    expect(store.isAborted()).toBe(false);

    const aborted = await store.abortTurn("user cancelled");
    expect(aborted.ok).toBe(true);
    if (!aborted.ok) {
      return;
    }

    expect(aborted.value).toBe(true);
    expect(signalResult.value.aborted).toBe(true);
    expect(store.isAborted()).toBe(true);
    expect(events).toEqual([
      {
        initiatedBy: "user",
        reason: "user cancelled",
      },
    ]);

    const secondAbort = await store.abortTurn("again");
    expect(secondAbort.ok).toBe(true);
    if (!secondAbort.ok) {
      return;
    }

    expect(secondAbort.value).toBe(false);
    expect(events).toHaveLength(1);
  });

  it("returns an error when restoring an unknown session", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore("missing-session");
    expect(restored.ok).toBe(false);
    if (!restored.ok) {
      expect(restored.error.message).toContain("Session not found");
    }
  });

  it("aborts an existing turn when a new turn starts", async () => {
    const context = await createContext();
    const bus = createHarnessEventBus();
    const events: Array<{ initiatedBy: "user" | "system"; reason?: string }> = [];

    bus.on("aborted", (event) => {
      events.push(event.payload);
    });

    const store = new SessionStore({
      eventBus: bus,
      sessionRepository: context.sessionRepository,
      conversationManager: context.conversationManager,
    });

    const firstTurn = store.startTurn();
    expect(firstTurn.ok).toBe(true);
    if (!firstTurn.ok) {
      return;
    }

    const secondTurn = store.startTurn();
    expect(secondTurn.ok).toBe(true);
    if (!secondTurn.ok) {
      return;
    }

    expect(firstTurn.value.aborted).toBe(true);
    expect(secondTurn.value.aborted).toBe(false);
    expect(events).toEqual([
      {
        initiatedBy: "system",
        reason: "superseded by a newer turn",
      },
    ]);
  });
});
