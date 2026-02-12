import { describe, expect, it } from "bun:test";

import { ConversationManager, InMemoryConversationStore } from "../../src/conversation";

type Platform = "tui" | "desktop" | "mobile";

const platforms: Platform[] = ["tui", "desktop", "mobile"];

interface Settings {
  defaultModel: string;
  notificationsEnabled: boolean;
  temperature: number;
}

class SharedSettingsStore {
  private value: Settings = {
    defaultModel: "shared-model",
    notificationsEnabled: true,
    temperature: 0.2,
  };

  private readonly listeners = new Set<(value: Settings) => void>();

  subscribe(listener: (value: Settings) => void): () => void {
    this.listeners.add(listener);
    listener(this.value);
    return () => this.listeners.delete(listener);
  }

  update(next: Settings): void {
    this.value = { ...next };
    for (const listener of this.listeners) {
      listener(this.value);
    }
  }
}

class OfflineQueue {
  private readonly pending: Array<{ content: string; role: "user" | "assistant" }> = [];
  private online = true;

  setOnline(value: boolean): void {
    this.online = value;
  }

  async send(
    manager: ConversationManager,
    conversationId: string,
    message: { role: "user" | "assistant"; content: string },
  ): Promise<void> {
    if (!this.online) {
      this.pending.push(message);
      return;
    }

    await manager.addMessage(conversationId, message);
  }

  async flush(manager: ConversationManager, conversationId: string): Promise<void> {
    if (!this.online) {
      return;
    }

    while (this.pending.length > 0) {
      const next = this.pending.shift();
      if (!next) {
        continue;
      }
      await manager.addMessage(conversationId, next);
    }
  }
}

describe("cross-platform/sync-parity", () => {
  it("syncs messages created on one platform to all others", async () => {
    const sharedStore = new InMemoryConversationStore();
    const managers: Record<Platform, ConversationManager> = {
      tui: new ConversationManager(sharedStore),
      desktop: new ConversationManager(sharedStore),
      mobile: new ConversationManager(sharedStore),
    };

    const conversation = await managers.tui.create({
      title: "Cross-platform sync",
      model: "shared-model",
      provider: "gateway",
    });

    await managers.tui.addMessage(conversation.id, {
      role: "user",
      content: "Created from TUI",
    });

    const desktopHistory = await managers.desktop.getHistory(conversation.id);
    const mobileHistory = await managers.mobile.getHistory(conversation.id);

    expect(desktopHistory[0]?.content).toBe("Created from TUI");
    expect(mobileHistory[0]?.content).toBe("Created from TUI");
  });

  it("keeps conversation state consistent after concurrent modifications", async () => {
    const sharedStore = new InMemoryConversationStore();
    const managerA = new ConversationManager(sharedStore);
    const managerB = new ConversationManager(sharedStore);

    const conversation = await managerA.create({
      title: "Concurrent parity",
      model: "shared-model",
      provider: "gateway",
    });

    await Promise.all([
      managerA.addMessage(conversation.id, { role: "user", content: "From A" }),
      managerB.addMessage(conversation.id, { role: "assistant", content: "From B" }),
    ]);

    const historyA = await managerA.getHistory(conversation.id);
    const historyB = await managerB.getHistory(conversation.id);

    expect(historyA.length).toBe(historyB.length);
    expect(historyA.map((message) => message.content)).toEqual(
      historyB.map((message) => message.content),
    );
    expect(["From A", "From B"]).toContain(historyA[0]?.content ?? "");
  });

  it("propagates settings updates to all platform consumers", () => {
    const store = new SharedSettingsStore();
    const observed: Record<Platform, Settings | null> = {
      tui: null,
      desktop: null,
      mobile: null,
    };

    const unsubscribe = platforms.map((platform) =>
      store.subscribe((value) => {
        observed[platform] = value;
      }),
    );

    const next: Settings = {
      defaultModel: "gpt-4o-mini",
      notificationsEnabled: false,
      temperature: 0.6,
    };
    store.update(next);

    for (const platform of platforms) {
      expect(observed[platform]).toEqual(next);
    }

    for (const stop of unsubscribe) {
      stop();
    }
  });

  it("flushes offline queue messages into synced history in order", async () => {
    const sharedStore = new InMemoryConversationStore();
    const managers: Record<Platform, ConversationManager> = {
      tui: new ConversationManager(sharedStore),
      desktop: new ConversationManager(sharedStore),
      mobile: new ConversationManager(sharedStore),
    };

    const conversation = await managers.mobile.create({
      title: "Offline queue parity",
      model: "shared-model",
      provider: "gateway",
    });

    const queue = new OfflineQueue();
    queue.setOnline(false);

    await queue.send(managers.mobile, conversation.id, { role: "user", content: "Queued one" });
    await queue.send(managers.mobile, conversation.id, { role: "user", content: "Queued two" });

    let preFlushHistory = await managers.desktop.getHistory(conversation.id);
    expect(preFlushHistory).toHaveLength(0);

    queue.setOnline(true);
    await queue.flush(managers.mobile, conversation.id);

    preFlushHistory = await managers.desktop.getHistory(conversation.id);
    const mobileHistory = await managers.mobile.getHistory(conversation.id);

    expect(preFlushHistory.map((message) => message.content)).toEqual(["Queued one", "Queued two"]);
    expect(mobileHistory.map((message) => message.content)).toEqual(["Queued one", "Queued two"]);
  });
});
