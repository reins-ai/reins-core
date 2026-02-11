import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConversationManager, InMemoryConversationStore, SessionRepository } from "../../src/conversation";
import { getSessionsDir } from "../../src/daemon/paths";

interface TempSessionHarness {
  homeDirectory: string;
  repository: SessionRepository;
  manager: ConversationManager;
}

const temporaryDirectories: string[] = [];

async function createHarness(): Promise<TempSessionHarness> {
  const homeDirectory = await mkdtemp(join(tmpdir(), "reins-session-meta-"));
  temporaryDirectories.push(homeDirectory);

  const daemonPathOptions = {
    platform: "linux" as const,
    env: {},
    homeDirectory,
  };

  const repository = new SessionRepository({
    daemonPathOptions,
    defaultTitle: "Main Session",
    defaultModel: "gpt-4o-mini",
    defaultProvider: "openai",
  });

  const manager = new ConversationManager(new InMemoryConversationStore(), repository);

  return {
    homeDirectory,
    repository,
    manager,
  };
}

describe("SessionRepository", () => {
  afterEach(async () => {
    while (temporaryDirectories.length > 0) {
      const directory = temporaryDirectories.pop();
      if (!directory) {
        continue;
      }

      await rm(directory, { recursive: true, force: true });
    }
  });

  it("creates a default main session on first run", async () => {
    const harness = await createHarness();

    const main = await harness.repository.getMain();
    expect(main.ok).toBe(true);
    if (!main.ok) {
      return;
    }

    expect(main.value.id.startsWith("sess_")).toBe(true);
    expect(main.value.title).toBe("Main Session");
    expect(main.value.isMain).toBe(true);
    expect(main.value.status).toBe("active");
    expect(main.value.model).toBe("gpt-4o-mini");
    expect(main.value.provider).toBe("openai");

    const sessionsDir = getSessionsDir({
      platform: "linux",
      env: {},
      homeDirectory: harness.homeDirectory,
    });
    const sessionsFileExists = await Bun.file(join(sessionsDir, "sessions.json")).exists();
    expect(sessionsFileExists).toBe(true);
  });

  it("resumes the current main session through ConversationManager", async () => {
    const harness = await createHarness();

    const firstMain = await harness.manager.resumeMain();
    expect(firstMain.ok).toBe(true);
    if (!firstMain.ok) {
      return;
    }

    const started = await harness.manager.startNewSession({
      title: "Fresh Session",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
    });
    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }

    const resumed = await harness.manager.resumeMain();
    expect(resumed.ok).toBe(true);
    if (!resumed.ok) {
      return;
    }

    expect(resumed.value.id).toBe(started.value.id);
    expect(resumed.value.id).not.toBe(firstMain.value.id);
    expect(resumed.value.isMain).toBe(true);
  });

  it("newSession creates a fresh main session and archives the previous main", async () => {
    const harness = await createHarness();
    const firstMain = await harness.repository.getMain();
    expect(firstMain.ok).toBe(true);
    if (!firstMain.ok) {
      return;
    }

    const nextMain = await harness.repository.newSession({
      title: "Second Session",
      model: "gpt-4.1",
      provider: "openai",
    });
    expect(nextMain.ok).toBe(true);
    if (!nextMain.ok) {
      return;
    }

    const sessions = await harness.repository.list();
    expect(sessions.ok).toBe(true);
    if (!sessions.ok) {
      return;
    }

    const archived = sessions.value.find((session) => session.id === firstMain.value.id);
    const active = sessions.value.find((session) => session.id === nextMain.value.id);

    expect(archived?.status).toBe("archived");
    expect(archived?.isMain).toBe(false);
    expect(active?.status).toBe("active");
    expect(active?.isMain).toBe(true);
  });

  it("uses atomic persistence and ignores leftover temp files", async () => {
    const harness = await createHarness();
    const sessionsDir = getSessionsDir({
      platform: "linux",
      env: {},
      homeDirectory: harness.homeDirectory,
    });
    const sessionsFilePath = join(sessionsDir, "sessions.json");

    const seeded = await harness.repository.getMain();
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) {
      return;
    }

    await writeFile(`${sessionsFilePath}.partial-crash`, "{\"incomplete\":true}", "utf8");
    await harness.repository.newSession({
      title: "Atomic Session",
      model: "gpt-4o-mini",
      provider: "openai",
    });

    const files = await readdir(sessionsDir);
    const generatedTempFiles = files.filter((name) => name.startsWith("sessions.json.tmp-"));
    expect(generatedTempFiles).toHaveLength(0);

    const reloadedRepository = new SessionRepository({
      daemonPathOptions: {
        platform: "linux",
        env: {},
        homeDirectory: harness.homeDirectory,
      },
      defaultModel: "gpt-4o-mini",
      defaultProvider: "openai",
    });

    const main = await reloadedRepository.getMain();
    expect(main.ok).toBe(true);
    if (!main.ok) {
      return;
    }

    expect(main.value.id.startsWith("sess_")).toBe(true);
  });

  it("lists all persisted sessions", async () => {
    const harness = await createHarness();

    const second = await harness.repository.create({
      title: "Secondary",
      model: "gpt-4o-mini",
      provider: "openai",
    });
    expect(second.ok).toBe(true);

    const third = await harness.repository.newSession({
      title: "Third",
      model: "claude-3-5-sonnet",
      provider: "anthropic",
    });
    expect(third.ok).toBe(true);

    const listed = await harness.repository.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }

    expect(listed.value.length).toBe(3);
    expect(listed.value.some((session) => session.title === "Secondary")).toBe(true);
    expect(listed.value.some((session) => session.title === "Third")).toBe(true);
  });

  it("cannot delete the main session without replacement", async () => {
    const harness = await createHarness();
    const main = await harness.repository.getMain();
    expect(main.ok).toBe(true);
    if (!main.ok) {
      return;
    }

    const deleted = await harness.repository.delete(main.value.id);
    expect(deleted.ok).toBe(false);
    if (!deleted.ok) {
      expect(deleted.error.message).toContain("Cannot delete the main session without a replacement");
    }
  });
});
