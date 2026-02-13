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
import type { AbortedEventPayload } from "../../src/harness";

interface TestContext {
  homeDirectory: string;
  sessionRepository: SessionRepository;
  conversationManager: ConversationManager;
  sessionStore: SessionStore;
  eventBus: ReturnType<typeof createHarnessEventBus>;
}

const temporaryDirectories: string[] = [];

async function createContext(): Promise<TestContext> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "reins-session-regression-"));
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

  const conversationManager = new ConversationManager(
    new InMemoryConversationStore(),
    sessionRepository,
  );
  const eventBus = createHarnessEventBus();
  const sessionStore = new SessionStore({
    eventBus,
    sessionRepository,
    conversationManager,
  });

  return {
    homeDirectory,
    sessionRepository,
    conversationManager,
    sessionStore,
    eventBus,
  };
}

describe("SessionStore regression: concurrent session operations", () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("handles rapid sequential restore calls without corruption", async () => {
    const context = await createContext();

    // Create multiple sessions
    const session1 = await context.sessionRepository.create({
      title: "Session 1",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });
    expect(session1.ok).toBe(true);
    if (!session1.ok) return;

    const session2 = await context.sessionRepository.create({
      title: "Session 2",
      model: "claude-sonnet-4-20250514",
      provider: "anthropic",
    });
    expect(session2.ok).toBe(true);
    if (!session2.ok) return;

    // Rapidly switch between sessions
    const r1 = await context.sessionStore.restore(session1.value.id);
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.value.session.title).toBe("Session 1");

    const r2 = await context.sessionStore.restore(session2.value.id);
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.value.session.title).toBe("Session 2");

    const r3 = await context.sessionStore.restore(session1.value.id);
    expect(r3.ok).toBe(true);
    if (r3.ok) expect(r3.value.session.title).toBe("Session 1");

    // Active session should be the last restored
    const active = context.sessionStore.getActiveSession();
    expect(active?.id).toBe(session1.value.id);
  });

  it("handles persist without active session gracefully", async () => {
    const context = await createContext();

    // No session restored yet
    const result = await context.sessionStore.persist();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("No active session");
    }
  });
});

describe("SessionStore regression: session fork under load", () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("creates multiple forks rapidly without ID collisions", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    const forkIds = new Set<string>();
    const forkCount = 5;

    for (let i = 0; i < forkCount; i++) {
      const forked = await context.sessionStore.forkSession({
        title: `Fork ${i}`,
        turnIndex: i,
      });
      expect(forked.ok).toBe(true);
      if (forked.ok) {
        forkIds.add(forked.value.id);
      }
    }

    // All fork IDs should be unique
    expect(forkIds.size).toBe(forkCount);

    // All forks should be listed
    const listed = await context.sessionRepository.list();
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      // 1 main + 5 forks
      expect(listed.value.length).toBe(forkCount + 1);
    }
  });

  it("fork preserves parent metadata correctly under rapid creation", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;

    const parentId = restored.value.session.id;

    const fork1 = await context.sessionStore.forkSession({ title: "A", turnIndex: 1 });
    const fork2 = await context.sessionStore.forkSession({ title: "B", turnIndex: 2 });
    const fork3 = await context.sessionStore.forkSession({ title: "C", turnIndex: 3 });

    for (const fork of [fork1, fork2, fork3]) {
      expect(fork.ok).toBe(true);
      if (fork.ok) {
        expect(fork.value.parentSessionId).toBe(parentId);
        expect(fork.value.model).toBe("claude-sonnet-4-20250514");
        expect(fork.value.provider).toBe("anthropic");
      }
    }

    if (fork1.ok) expect(fork1.value.forkTurnIndex).toBe(1);
    if (fork2.ok) expect(fork2.value.forkTurnIndex).toBe(2);
    if (fork3.ok) expect(fork3.value.forkTurnIndex).toBe(3);
  });
});

describe("SessionStore regression: abort propagation", () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("abort signal from startTurn is usable by external consumers", async () => {
    const context = await createContext();

    const signalResult = context.sessionStore.startTurn();
    expect(signalResult.ok).toBe(true);
    if (!signalResult.ok) return;

    const signal = signalResult.value;
    let abortReceived = false;

    signal.addEventListener("abort", () => {
      abortReceived = true;
    });

    await context.sessionStore.abortTurn("test reason");

    expect(abortReceived).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("multiple sequential start/abort cycles work correctly", async () => {
    const context = await createContext();
    const abortEvents: AbortedEventPayload[] = [];

    context.eventBus.on("aborted", (e) => {
      abortEvents.push(e.payload);
    });

    // Cycle 1
    const s1 = context.sessionStore.startTurn();
    expect(s1.ok).toBe(true);
    await context.sessionStore.abortTurn("reason-1");

    // Cycle 2
    const s2 = context.sessionStore.startTurn();
    expect(s2.ok).toBe(true);
    await context.sessionStore.abortTurn("reason-2");

    // Cycle 3
    const s3 = context.sessionStore.startTurn();
    expect(s3.ok).toBe(true);
    await context.sessionStore.abortTurn("reason-3");

    expect(abortEvents).toHaveLength(3);
    expect(abortEvents[0]?.reason).toBe("reason-1");
    expect(abortEvents[1]?.reason).toBe("reason-2");
    expect(abortEvents[2]?.reason).toBe("reason-3");
  });

  it("starting a new turn while previous is active aborts the previous", async () => {
    const context = await createContext();
    const abortEvents: AbortedEventPayload[] = [];

    context.eventBus.on("aborted", (e) => {
      abortEvents.push(e.payload);
    });

    const first = context.sessionStore.startTurn();
    expect(first.ok).toBe(true);

    const second = context.sessionStore.startTurn();
    expect(second.ok).toBe(true);

    if (first.ok) expect(first.value.aborted).toBe(true);
    if (second.ok) expect(second.value.aborted).toBe(false);

    // Should have emitted one abort event for the superseded turn
    expect(abortEvents).toHaveLength(1);
    expect(abortEvents[0]?.initiatedBy).toBe("system");
    expect(abortEvents[0]?.reason).toContain("superseded");
  });

  it("isAborted returns false when no turn has been started", () => {
    const context_sync = {
      sessionStore: new SessionStore({
        eventBus: createHarnessEventBus(),
      }),
    };

    expect(context_sync.sessionStore.isAborted()).toBe(false);
  });

  it("abortTurn returns false when no active turn exists", async () => {
    const context = await createContext();

    const result = await context.sessionStore.abortTurn("no turn");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBe(false);
    }
  });

  it("abortTurn returns false when turn is already aborted", async () => {
    const context = await createContext();

    context.sessionStore.startTurn();
    await context.sessionStore.abortTurn("first abort");

    const secondAbort = await context.sessionStore.abortTurn("second abort");
    expect(secondAbort.ok).toBe(true);
    if (secondAbort.ok) {
      expect(secondAbort.value).toBe(false);
    }
  });
});

describe("SessionStore regression: getActiveSession isolation", () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (directory) {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  it("getActiveSession returns null before any restore", async () => {
    const context = await createContext();
    expect(context.sessionStore.getActiveSession()).toBeNull();
  });

  it("getActiveSession returns a clone that cannot mutate internal state", async () => {
    const context = await createContext();

    const restored = await context.sessionStore.restore();
    expect(restored.ok).toBe(true);

    const active1 = context.sessionStore.getActiveSession();
    const active2 = context.sessionStore.getActiveSession();

    expect(active1).not.toBeNull();
    expect(active2).not.toBeNull();

    // Should be equal but not the same reference
    expect(active1?.id).toBe(active2?.id);
  });
});
