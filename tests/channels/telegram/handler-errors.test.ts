import { describe, expect, it } from "bun:test";

import { TelegramChannel } from "../../../src/channels/telegram/channel";
import type { TelegramChannelClient } from "../../../src/channels/telegram/channel";
import type { Logger } from "../../../src/logger";
import type { ChannelMessage } from "../../../src/channels/types";
import type { TelegramFile, TelegramUpdate } from "../../../src/channels/telegram/types";

// ---------------------------------------------------------------------------
// Shared test utilities
// ---------------------------------------------------------------------------

interface ScheduledTask {
  id: number;
  delayMs: number;
  callback: () => void;
  cleared: boolean;
}

class PollScheduler {
  private tasks: ScheduledTask[] = [];
  private nextId = 1;

  public schedule = (callback: () => void, delayMs: number): ReturnType<typeof setTimeout> => {
    const task: ScheduledTask = {
      id: this.nextId,
      delayMs,
      callback,
      cleared: false,
    };
    this.nextId += 1;
    this.tasks.push(task);
    return task.id as ReturnType<typeof setTimeout>;
  };

  public clear = (timer: ReturnType<typeof setTimeout>): void => {
    const numericTimer = timer as unknown as number;
    const task = this.tasks.find((entry) => entry.id === numericTimer);
    if (task !== undefined) {
      task.cleared = true;
    }
  };

  public async flush(limit = 10): Promise<void> {
    for (let index = 0; index < limit; index += 1) {
      const task = this.tasks.shift();
      if (task === undefined) {
        return;
      }

      if (task.cleared) {
        continue;
      }

      task.callback();
      for (let tick = 0; tick < 20; tick += 1) {
        await Promise.resolve();
      }
    }
  }
}

interface LogEntry {
  level: string;
  message: string;
  data?: Record<string, unknown>;
}

function createMockLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    logger: {
      debug: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "debug", message: msg, data }),
      info: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "info", message: msg, data }),
      warn: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "warn", message: msg, data }),
      error: (msg: string, data?: Record<string, unknown>) => entries.push({ level: "error", message: msg, data }),
    },
    entries,
  };
}

class MockTelegramClient implements TelegramChannelClient {
  public getMeCalls = 0;
  public sendMessageCalls: Array<{ chatId: string | number; text: string }> = [];

  private readonly updatesQueue: Array<TelegramUpdate[] | Error>;
  private sendMessageBehavior: ((chatId: string | number, text: string) => Promise<unknown>) | null = null;

  constructor(options: { updatesQueue?: Array<TelegramUpdate[] | Error> } = {}) {
    this.updatesQueue = options.updatesQueue ?? [];
  }

  public setSendMessageBehavior(fn: (chatId: string | number, text: string) => Promise<unknown>): void {
    this.sendMessageBehavior = fn;
  }

  public async getMe(): Promise<unknown> {
    this.getMeCalls += 1;
    return { id: 10, is_bot: true };
  }

  public async getUpdates(): Promise<TelegramUpdate[]> {
    const next = this.updatesQueue.shift();
    if (next === undefined) {
      return [];
    }
    if (next instanceof Error) {
      throw next;
    }
    return next;
  }

  public async getFile(fileId: string): Promise<TelegramFile> {
    return {
      file_id: fileId,
      file_unique_id: `${fileId}-uid`,
      file_path: `${fileId}.bin`,
    };
  }

  public async downloadFile(): Promise<{ data: Uint8Array; contentType?: string }> {
    return {
      data: new Uint8Array([1, 2, 3]),
      contentType: "application/octet-stream",
    };
  }

  public async sendMessage(chatId: string | number, text: string): Promise<unknown> {
    this.sendMessageCalls.push({ chatId, text });
    if (this.sendMessageBehavior !== null) {
      return this.sendMessageBehavior(chatId, text);
    }
    return {};
  }

  public async sendPhoto(): Promise<unknown> {
    return {};
  }

  public async sendDocument(): Promise<unknown> {
    return {};
  }

  public async sendVoice(): Promise<unknown> {
    return {};
  }

  public async sendChatAction(): Promise<unknown> {
    return {};
  }
}

function makeConfig() {
  return { id: "telegram-test", platform: "telegram" as const, tokenReference: "ref", enabled: true };
}

function makeTextUpdate(text: string, chatId = 12345, updateId = 1): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: "private", first_name: "Alice" },
      from: { id: 42, is_bot: false, first_name: "Alice", username: "alice" },
      text,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handler error logging in dispatchUpdates", () => {
  it("handler failure emits log.warn with correct structured fields", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      updatesQueue: [[makeTextUpdate("hello", 12345, 500)]],
    });
    const { logger, entries } = createMockLogger();

    const channel = new TelegramChannel({
      config: makeConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
      retrySendDelayFn: () => Promise.resolve(),
      logger,
    });

    channel.onMessage(async () => {
      throw new Error("Handler exploded");
    });

    await channel.connect();
    await scheduler.flush(1);

    const warnEntry = entries.find(
      (entry) => entry.level === "warn" && entry.message === "message handler failed",
    );

    expect(warnEntry).toBeDefined();
    expect(warnEntry!.data?.updateId).toBe(500);
    expect(warnEntry!.data?.handlerIndex).toBe(0);
    expect(warnEntry!.data?.error).toBe("Handler exploded");

    await channel.disconnect();
  });

  it("handler failure sets statusState.lastError", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      updatesQueue: [[makeTextUpdate("hello", 12345, 501)]],
    });
    const { logger } = createMockLogger();

    const channel = new TelegramChannel({
      config: makeConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
      retrySendDelayFn: () => Promise.resolve(),
      logger,
    });

    channel.onMessage(async () => {
      throw new Error("Handler exploded");
    });

    await channel.connect();
    await scheduler.flush(1);

    expect(channel.status.lastError).toContain("Handler exploded");

    await channel.disconnect();
  });

  it("second handler index is correct in log entry", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      updatesQueue: [[makeTextUpdate("hello", 12345, 502)]],
    });
    const { logger, entries } = createMockLogger();

    const channel = new TelegramChannel({
      config: makeConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
      retrySendDelayFn: () => Promise.resolve(),
      logger,
    });

    // First handler succeeds
    channel.onMessage(async () => {
      // no-op
    });

    // Second handler throws
    channel.onMessage(async () => {
      throw new Error("Second handler exploded");
    });

    await channel.connect();
    await scheduler.flush(1);

    const warnEntry = entries.find(
      (entry) => entry.level === "warn" && entry.message === "message handler failed",
    );

    expect(warnEntry).toBeDefined();
    expect(warnEntry!.data?.handlerIndex).toBe(1);
    expect(warnEntry!.data?.error).toBe("Second handler exploded");

    await channel.disconnect();
  });

  it("poll loop continues after handler failure (second update processed)", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      updatesQueue: [
        [makeTextUpdate("first", 12345, 503), makeTextUpdate("second", 12345, 504)],
      ],
    });
    const { logger } = createMockLogger();

    let callCount = 0;
    const receivedTexts: string[] = [];

    const channel = new TelegramChannel({
      config: makeConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
      retrySendDelayFn: () => Promise.resolve(),
      logger,
    });

    channel.onMessage(async (msg) => {
      callCount += 1;
      if (callCount === 1) {
        throw new Error("First update fails");
      }
      receivedTexts.push(msg.text ?? "");
    });

    await channel.connect();
    await scheduler.flush(1);

    expect(receivedTexts).toEqual(["second"]);
    expect(channel.status.state).toBe("connected");

    await channel.disconnect();
  });

  it("multiple handlers: first fails, second still runs", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      updatesQueue: [[makeTextUpdate("hello", 12345, 505)]],
    });
    const { logger } = createMockLogger();

    const receivedMessages: ChannelMessage[] = [];

    const channel = new TelegramChannel({
      config: makeConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
      retrySendDelayFn: () => Promise.resolve(),
      logger,
    });

    // First handler throws
    channel.onMessage(async () => {
      throw new Error("First handler fails");
    });

    // Second handler records
    channel.onMessage(async (msg) => {
      receivedMessages.push(msg);
    });

    await channel.connect();
    await scheduler.flush(1);

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]!.text).toBe("hello");

    await channel.disconnect();
  });
});

describe("send failure after retries propagates", () => {
  it("send failure after all retries exhausted is logged via handler catch block", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      updatesQueue: [[makeTextUpdate("trigger send", 12345, 600)]],
    });
    const { logger, entries } = createMockLogger();

    client.setSendMessageBehavior(async () => {
      throw new Error("ECONNRESET");
    });

    const channel = new TelegramChannel({
      config: makeConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
      retrySendDelayFn: () => Promise.resolve(),
      logger,
    });

    channel.onMessage(async (msg) => {
      // Handler attempts to send a reply — sendMessage always fails with ECONNRESET
      await channel.send({
        id: "reply-1",
        platform: "telegram",
        channelId: "12345",
        sender: { id: "bot", isBot: true },
        timestamp: new Date(),
        text: "Reply text",
        platformData: { chat_id: 12345 },
      });
    });

    await channel.connect();
    await scheduler.flush(1);

    const warnEntry = entries.find(
      (entry) => entry.level === "warn" && entry.message === "message handler failed",
    );

    expect(warnEntry).toBeDefined();
    expect(warnEntry!.data?.error).toContain("ECONNRESET");
    expect(channel.status.lastError).toContain("ECONNRESET");

    await channel.disconnect();
  });
});
