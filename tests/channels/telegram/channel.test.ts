import { describe, expect, it } from "bun:test";

import { ChannelError } from "../../../src/channels/errors";
import { TelegramChannel } from "../../../src/channels/telegram/channel";
import type { TelegramChannelClient } from "../../../src/channels/telegram/channel";
import type { ChannelConfig, ChannelMessage } from "../../../src/channels/types";
import type { TelegramUpdate } from "../../../src/channels/telegram/types";

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

  public pendingDelays(): number[] {
    return this.tasks.filter((task) => !task.cleared).map((task) => task.delayMs);
  }

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
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
  }
}

interface SendCall {
  chatId: string | number;
  value: string;
  options?: Record<string, unknown>;
}

class MockTelegramClient implements TelegramChannelClient {
  public getMeCalls = 0;
  public getUpdatesCalls: Array<number | undefined> = [];
  public sendMessageCalls: SendCall[] = [];
  public sendPhotoCalls: SendCall[] = [];
  public sendDocumentCalls: SendCall[] = [];
  public sendVoiceCalls: SendCall[] = [];
  public sendChatActionCalls: Array<{ chatId: string | number; action: string }> = [];

  private readonly updatesQueue: Array<TelegramUpdate[] | Error>;
  private readonly getMeError: Error | null;

  constructor(options: { updatesQueue?: Array<TelegramUpdate[] | Error>; getMeError?: Error } = {}) {
    this.updatesQueue = options.updatesQueue ?? [];
    this.getMeError = options.getMeError ?? null;
  }

  public async getMe(): Promise<unknown> {
    this.getMeCalls += 1;

    if (this.getMeError !== null) {
      throw this.getMeError;
    }

    return { id: 10, is_bot: true };
  }

  public async getUpdates(offset?: number): Promise<TelegramUpdate[]> {
    this.getUpdatesCalls.push(offset);
    const next = this.updatesQueue.shift();

    if (next === undefined) {
      return [];
    }

    if (next instanceof Error) {
      throw next;
    }

    return next;
  }

  public async sendMessage(chatId: string | number, text: string, options?: Record<string, unknown>): Promise<unknown> {
    this.sendMessageCalls.push({ chatId, value: text, options });
    return {};
  }

  public async sendPhoto(chatId: string | number, photo: string, options?: Record<string, unknown>): Promise<unknown> {
    this.sendPhotoCalls.push({ chatId, value: photo, options });
    return {};
  }

  public async sendDocument(
    chatId: string | number,
    document: string,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sendDocumentCalls.push({ chatId, value: document, options });
    return {};
  }

  public async sendVoice(chatId: string | number, voice: string, options?: Record<string, unknown>): Promise<unknown> {
    this.sendVoiceCalls.push({ chatId, value: voice, options });
    return {};
  }

  public async sendChatAction(chatId: string | number, action: "typing"): Promise<unknown> {
    this.sendChatActionCalls.push({ chatId, action });
    return { ok: true };
  }
}

function createConfig(): ChannelConfig {
  return {
    id: "telegram-main",
    platform: "telegram",
    tokenReference: "cred://telegram/main",
    enabled: true,
  };
}

function createUpdate(updateId: number, messageId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: 1_735_689_600,
      chat: {
        id: 42,
        type: "private",
      },
      from: {
        id: 999,
        is_bot: false,
        first_name: "User",
      },
      text,
    },
  };
}

function createOutboundMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    id: "outbound-1",
    platform: "telegram",
    channelId: "42",
    sender: {
      id: "assistant",
      isBot: true,
    },
    timestamp: new Date(),
    text: "hello from reins",
    platformData: {
      chat_id: 42,
    },
    ...overrides,
  };
}

describe("TelegramChannel", () => {
  it("connects and starts long-polling", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient();
    const channel = new TelegramChannel({
      config: createConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
    });

    await channel.connect();

    expect(client.getMeCalls).toBe(1);
    expect(channel.status.state).toBe("connected");
    expect(scheduler.pendingDelays()).toEqual([0]);
  });

  it("normalizes updates and invokes message handlers", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      updatesQueue: [
        [
          createUpdate(10, 100, "first"),
          createUpdate(11, 101, "second"),
        ],
        [],
      ],
    });

    const received: string[] = [];
    const channel = new TelegramChannel({
      config: createConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
    });

    channel.onMessage((message) => {
      if (message.text !== undefined) {
        received.push(message.text);
      }
    });

    await channel.connect();
    await scheduler.flush(1);
    await scheduler.flush(1);

    expect(received).toEqual(["first", "second"]);
    expect(client.getUpdatesCalls).toEqual([undefined, 12]);
  });

  it("sends text, photo, document, and voice messages", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient();
    const channel = new TelegramChannel({
      config: createConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
    });

    await channel.connect();

    await channel.send(createOutboundMessage({ text: "plain text" }));
    await channel.send(
      createOutboundMessage({
        text: "image caption",
        attachments: [{ type: "image", platformData: { file_id: "photo-file" } }],
      }),
    );
    await channel.send(
      createOutboundMessage({
        text: "doc caption",
        attachments: [{ type: "file", platformData: { file_id: "doc-file" } }],
      }),
    );
    await channel.send(
      createOutboundMessage({
        text: undefined,
        voice: { platformData: { file_id: "voice-file" } },
      }),
    );

    expect(client.sendMessageCalls).toHaveLength(1);
    expect(client.sendMessageCalls[0]).toEqual({ chatId: 42, value: "plain text", options: undefined });
    expect(client.sendPhotoCalls[0]).toEqual({
      chatId: 42,
      value: "photo-file",
      options: { caption: "image caption" },
    });
    expect(client.sendDocumentCalls[0]).toEqual({
      chatId: 42,
      value: "doc-file",
      options: { caption: "doc caption" },
    });
    expect(client.sendVoiceCalls[0]).toEqual({ chatId: 42, value: "voice-file", options: undefined });
  });

  it("emits typing indicator for the destination chat", async () => {
    const client = new MockTelegramClient();
    const channel = new TelegramChannel({
      config: createConfig(),
      client,
    });

    await channel.sendTypingIndicator("42");

    expect(client.sendChatActionCalls).toEqual([{ chatId: 42, action: "typing" }]);
  });

  it("disconnects and stops future polling", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient();
    const channel = new TelegramChannel({
      config: createConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
    });

    await channel.connect();
    await channel.disconnect();
    await scheduler.flush();

    expect(channel.status.state).toBe("disconnected");
    expect(client.getUpdatesCalls).toHaveLength(0);
  });

  it("reconnects with exponential backoff after polling errors", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      updatesQueue: [new Error("connection lost"), []],
    });

    const channel = new TelegramChannel({
      config: createConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
      initialReconnectDelayMs: 100,
      maxReconnectDelayMs: 1_000,
    });

    await channel.connect();
    await scheduler.flush(1);

    expect(channel.status.state).toBe("reconnecting");
    expect(channel.status.lastError).toContain("connection lost");
    expect(scheduler.pendingDelays()).toEqual([100]);

    await scheduler.flush(1);

    expect(channel.status.state).toBe("connected");
    expect(channel.status.lastError).toBeUndefined();
  });

  it("tracks error status when initial connect fails", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      getMeError: new Error("invalid token"),
    });

    const channel = new TelegramChannel({
      config: createConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
    });

    await expect(channel.connect()).rejects.toThrow(ChannelError);
    expect(channel.status.state).toBe("error");
    expect(channel.status.lastError).toContain("invalid token");
  });

  it("supports unsubscribing message handlers", async () => {
    const scheduler = new PollScheduler();
    const client = new MockTelegramClient({
      updatesQueue: [[createUpdate(1, 10, "hello")]],
    });

    const messages: string[] = [];
    const channel = new TelegramChannel({
      config: createConfig(),
      client,
      schedulePollFn: scheduler.schedule,
      clearScheduledPollFn: scheduler.clear,
    });

    const unsubscribe = channel.onMessage((message) => {
      messages.push(message.text ?? "");
    });
    unsubscribe();

    await channel.connect();
    await scheduler.flush(1);

    expect(messages).toEqual([]);
  });

  it("throws when sending while disconnected", async () => {
    const client = new MockTelegramClient();
    const channel = new TelegramChannel({
      config: createConfig(),
      client,
    });

    await expect(channel.send(createOutboundMessage())).rejects.toThrow(ChannelError);
  });
});
