import { describe, expect, it } from "bun:test";

import { TelegramChannel } from "../../../src/channels/telegram/channel";
import type { TelegramChannelClient } from "../../../src/channels/telegram/channel";
import type { ChannelConfig, ChannelMessage } from "../../../src/channels/types";
import type { TelegramFile, TelegramUpdate } from "../../../src/channels/telegram/types";

// ---------------------------------------------------------------------------
// Test utilities
// ---------------------------------------------------------------------------

type PollTimerHandle = ReturnType<typeof setTimeout>;

class PollScheduler {
  public schedule = (_callback: () => void, _delayMs: number): PollTimerHandle => {
    return 0 as unknown as PollTimerHandle;
  };

  public clear = (_timer: PollTimerHandle): void => {};
}

type SendMessageCallback = () => void;

interface MockClientOptions {
  sendMessageCallbacks?: SendMessageCallback[];
  sendVoiceCallbacks?: SendMessageCallback[];
}

class MockTelegramClientWithErrors implements TelegramChannelClient {
  public sendMessageCallCount = 0;
  public sendVoiceCallCount = 0;
  public sendPhotoCallCount = 0;
  public sendDocumentCallCount = 0;

  private readonly sendMessageCallbacks: SendMessageCallback[];
  private readonly sendVoiceCallbacks: SendMessageCallback[];

  constructor(options: MockClientOptions = {}) {
    this.sendMessageCallbacks = options.sendMessageCallbacks ?? [];
    this.sendVoiceCallbacks = options.sendVoiceCallbacks ?? [];
  }

  public async getMe(): Promise<unknown> {
    return { id: 10, is_bot: true };
  }

  public async getUpdates(): Promise<TelegramUpdate[]> {
    return [];
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

  public async sendMessage(
    _chatId: string | number,
    _text: string,
    _options?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sendMessageCallCount += 1;
    const callback = this.sendMessageCallbacks.shift();
    if (callback !== undefined) {
      callback();
    }
    return {};
  }

  public async sendPhoto(
    _chatId: string | number,
    _photo: string,
    _options?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sendPhotoCallCount += 1;
    return {};
  }

  public async sendDocument(
    _chatId: string | number,
    _document: string,
    _options?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sendDocumentCallCount += 1;
    return {};
  }

  public async sendVoice(
    _chatId: string | number,
    _voice: string,
    _options?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sendVoiceCallCount += 1;
    const callback = this.sendVoiceCallbacks.shift();
    if (callback !== undefined) {
      callback();
    }
    return {};
  }

  public async sendChatAction(
    _chatId: string | number,
    _action: "typing",
  ): Promise<unknown> {
    return { ok: true };
  }
}

function makeConfig(): ChannelConfig {
  return {
    id: "telegram-test",
    platform: "telegram",
    tokenReference: "ref",
    enabled: true,
  };
}

function makeTextOutbound(chatId: number | string = 42): ChannelMessage {
  return {
    id: "out-1",
    platform: "telegram",
    channelId: String(chatId),
    sender: { id: "reins-agent", isBot: true },
    timestamp: new Date(),
    text: "Hello",
    platformData: { chat_id: chatId },
  };
}

function makeVoiceOutbound(chatId: number | string = 42): ChannelMessage {
  return {
    id: "out-2",
    platform: "telegram",
    channelId: String(chatId),
    sender: { id: "reins-agent", isBot: true },
    timestamp: new Date(),
    voice: { platformData: { file_id: "voice_id" } },
    platformData: { chat_id: chatId },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TelegramChannel sendToChat retry", () => {
  describe("transient error retry", () => {
    it("retries once on transient error and succeeds", async () => {
      let callIndex = 0;
      const client = new MockTelegramClientWithErrors({
        sendMessageCallbacks: [
          () => {
            callIndex += 1;
            if (callIndex === 1) {
              throw new Error("ECONNRESET");
            }
          },
          () => {
            callIndex += 1;
          },
        ],
      });

      const recordedDelays: number[] = [];
      const scheduler = new PollScheduler();

      const channel = new TelegramChannel({
        config: makeConfig(),
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
        retrySendDelayFn: async (delayMs: number) => {
          recordedDelays.push(delayMs);
        },
      });

      await channel.connect();
      await channel.send(makeTextOutbound());

      expect(client.sendMessageCallCount).toBe(2);
      expect(recordedDelays).toEqual([500]);

      await channel.disconnect();
    });

    it("retries on 429 rate limit with longer base delay", async () => {
      let callIndex = 0;
      const client = new MockTelegramClientWithErrors({
        sendMessageCallbacks: [
          () => {
            callIndex += 1;
            if (callIndex === 1) {
              throw new Error("429 Too Many Requests");
            }
          },
          () => {
            callIndex += 1;
          },
        ],
      });

      const recordedDelays: number[] = [];
      const scheduler = new PollScheduler();

      const channel = new TelegramChannel({
        config: makeConfig(),
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
        retrySendDelayFn: async (delayMs: number) => {
          recordedDelays.push(delayMs);
        },
      });

      await channel.connect();
      await channel.send(makeTextOutbound());

      expect(client.sendMessageCallCount).toBe(2);
      expect(recordedDelays).toEqual([2000]);

      await channel.disconnect();
    });

    it("retries up to MAX_SEND_RETRIES (3) then throws original error", async () => {
      const client = new MockTelegramClientWithErrors({
        sendMessageCallbacks: [
          () => { throw new Error("ETIMEDOUT"); },
          () => { throw new Error("ETIMEDOUT"); },
          () => { throw new Error("ETIMEDOUT"); },
        ],
      });

      const recordedDelays: number[] = [];
      const scheduler = new PollScheduler();

      const channel = new TelegramChannel({
        config: makeConfig(),
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
        retrySendDelayFn: async (delayMs: number) => {
          recordedDelays.push(delayMs);
        },
      });

      await channel.connect();

      await expect(channel.send(makeTextOutbound())).rejects.toThrow("ETIMEDOUT");

      expect(client.sendMessageCallCount).toBe(3);
      expect(recordedDelays).toHaveLength(2);

      await channel.disconnect();
    });

    it("exponential backoff increases delay each attempt", async () => {
      const client = new MockTelegramClientWithErrors({
        sendMessageCallbacks: [
          () => { throw new Error("network error"); },
          () => { throw new Error("network error"); },
          () => { throw new Error("network error"); },
        ],
      });

      const recordedDelays: number[] = [];
      const scheduler = new PollScheduler();

      const channel = new TelegramChannel({
        config: makeConfig(),
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
        retrySendDelayFn: async (delayMs: number) => {
          recordedDelays.push(delayMs);
        },
      });

      await channel.connect();

      await expect(channel.send(makeTextOutbound())).rejects.toThrow("network error");

      // 500 * 2^0 = 500, 500 * 2^1 = 1000; 3rd failure re-throws without delay
      expect(recordedDelays).toEqual([500, 1000]);

      await channel.disconnect();
    });
  });

  describe("permanent error no retry", () => {
    it("does not retry on 400 Bad Request", async () => {
      const client = new MockTelegramClientWithErrors({
        sendMessageCallbacks: [
          () => { throw new Error("400 Bad Request"); },
        ],
      });

      const recordedDelays: number[] = [];
      const scheduler = new PollScheduler();

      const channel = new TelegramChannel({
        config: makeConfig(),
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
        retrySendDelayFn: async (delayMs: number) => {
          recordedDelays.push(delayMs);
        },
      });

      await channel.connect();

      await expect(channel.send(makeTextOutbound())).rejects.toThrow("400 Bad Request");

      expect(client.sendMessageCallCount).toBe(1);
      expect(recordedDelays).toHaveLength(0);

      await channel.disconnect();
    });

    it("does not retry on 403 Forbidden", async () => {
      const client = new MockTelegramClientWithErrors({
        sendMessageCallbacks: [
          () => { throw new Error("403 Forbidden"); },
        ],
      });

      const scheduler = new PollScheduler();

      const channel = new TelegramChannel({
        config: makeConfig(),
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
        retrySendDelayFn: async () => {},
      });

      await channel.connect();

      await expect(channel.send(makeTextOutbound())).rejects.toThrow("403 Forbidden");

      expect(client.sendMessageCallCount).toBe(1);

      await channel.disconnect();
    });
  });

  describe("success without retry", () => {
    it("does not call delay function when send succeeds immediately", async () => {
      const client = new MockTelegramClientWithErrors();

      const recordedDelays: number[] = [];
      const scheduler = new PollScheduler();

      const channel = new TelegramChannel({
        config: makeConfig(),
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
        retrySendDelayFn: async (delayMs: number) => {
          recordedDelays.push(delayMs);
        },
      });

      await channel.connect();
      await channel.send(makeTextOutbound());

      expect(client.sendMessageCallCount).toBe(1);
      expect(recordedDelays).toHaveLength(0);

      await channel.disconnect();
    });
  });

  describe("voice and photo also retry", () => {
    it("sendVoice retries on transient error", async () => {
      let callIndex = 0;
      const client = new MockTelegramClientWithErrors({
        sendVoiceCallbacks: [
          () => {
            callIndex += 1;
            if (callIndex === 1) {
              throw new Error("ECONNRESET");
            }
          },
          () => {
            callIndex += 1;
          },
        ],
      });

      const recordedDelays: number[] = [];
      const scheduler = new PollScheduler();

      const channel = new TelegramChannel({
        config: makeConfig(),
        client,
        schedulePollFn: scheduler.schedule,
        clearScheduledPollFn: scheduler.clear,
        retrySendDelayFn: async (delayMs: number) => {
          recordedDelays.push(delayMs);
        },
      });

      await channel.connect();
      await channel.send(makeVoiceOutbound());

      expect(client.sendVoiceCallCount).toBe(2);
      expect(recordedDelays).toEqual([500]);

      await channel.disconnect();
    });
  });
});
