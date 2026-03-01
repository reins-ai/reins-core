import { describe, expect, it } from "bun:test";

import { TelegramChannel } from "../../../src/channels/telegram/channel";
import type { TelegramChannelClient } from "../../../src/channels/telegram/channel";
import type { ChannelMessage } from "../../../src/channels/types";
import type { TelegramFile, TelegramUpdate } from "../../../src/channels/telegram/types";
import type { Logger } from "../../../src/logger";

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

type SendMessageHandler = (
  chatId: string | number,
  text: string,
  options?: Record<string, unknown>,
) => void;

class MockFallbackClient implements TelegramChannelClient {
  public readonly sendMessageCalls: Array<{
    chatId: string | number;
    text: string;
    options?: Record<string, unknown>;
  }> = [];

  private readonly sendMessageHandlers: SendMessageHandler[];

  constructor(handlers: SendMessageHandler[] = []) {
    this.sendMessageHandlers = [...handlers];
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
    chatId: string | number,
    text: string,
    options?: Record<string, unknown>,
  ): Promise<unknown> {
    this.sendMessageCalls.push({ chatId, text, options });
    const handler = this.sendMessageHandlers.shift();
    if (handler !== undefined) {
      handler(chatId, text, options);
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

function makeMarkdownV2Outbound(chatId: number | string = 42): ChannelMessage {
  return {
    id: "out-md",
    platform: "telegram",
    channelId: String(chatId),
    sender: { id: "reins-agent", isBot: true },
    timestamp: new Date(),
    text: "**Hello**",
    formatting: { mode: "markdown_v2" },
    platformData: { chat_id: chatId },
  };
}

function makePlainTextOutbound(chatId: number | string = 42): ChannelMessage {
  return {
    id: "out-plain",
    platform: "telegram",
    channelId: String(chatId),
    sender: { id: "reins-agent", isBot: true },
    timestamp: new Date(),
    text: "Hello plain",
    platformData: { chat_id: chatId },
  };
}

function makeChannel(client: TelegramChannelClient, logger?: Logger): TelegramChannel {
  const scheduler = new PollScheduler();
  return new TelegramChannel({
    config: { id: "test", platform: "telegram", tokenReference: "ref", enabled: true },
    client,
    schedulePollFn: scheduler.schedule,
    clearScheduledPollFn: scheduler.clear,
    retrySendDelayFn: async () => {},
    logger,
  });
}

// ---------------------------------------------------------------------------
// Tests — Task 3.1: MarkdownV2 fallback to plain text
// ---------------------------------------------------------------------------

describe("TelegramChannel MarkdownV2 fallback to plain text", () => {
  it("retries as plain text when MarkdownV2 send gets 400", async () => {
    const client = new MockFallbackClient([
      (_chatId, _text, _options) => {
        throw new Error("400 Bad Request: can't parse entities");
      },
      // Second call (plain text retry) succeeds — no handler needed
    ]);

    const channel = makeChannel(client);
    await channel.connect();
    await channel.send(makeMarkdownV2Outbound());

    expect(client.sendMessageCalls).toHaveLength(2);

    // First call: with parseMode
    expect(client.sendMessageCalls[0]!.options).toEqual({ parseMode: "MarkdownV2" });
    expect(client.sendMessageCalls[0]!.text).toBe("**Hello**");

    // Second call: without parseMode
    expect(client.sendMessageCalls[1]!.options).toBeUndefined();
    expect(client.sendMessageCalls[1]!.text).toBe("**Hello**");

    await channel.disconnect();
  });

  it("throws immediately when non-MarkdownV2 send gets 400", async () => {
    const client = new MockFallbackClient([
      () => {
        throw new Error("400 Bad Request");
      },
    ]);

    const channel = makeChannel(client);
    await channel.connect();

    await expect(channel.send(makePlainTextOutbound())).rejects.toThrow("400 Bad Request");

    // Only one call — no fallback retry
    expect(client.sendMessageCalls).toHaveLength(1);
    expect(client.sendMessageCalls[0]!.options).toBeUndefined();

    await channel.disconnect();
  });

  it("does not retry MarkdownV2 fallback on 403 and falls through to error message", async () => {
    const client = new MockFallbackClient([
      // Tier 1: MarkdownV2 → 403 (not a parse error)
      () => {
        throw new Error("403 Forbidden");
      },
      // Inner catch re-throws (403 is not a 400 parse error).
      // Outer catch absorbs because parseMode was set, sends error fallback.
    ]);

    const channel = makeChannel(client);
    await channel.connect();

    // Does NOT throw — outer catch absorbs when parseMode was set
    await channel.send(makeMarkdownV2Outbound());

    // Two calls: original MarkdownV2 attempt + error fallback message
    expect(client.sendMessageCalls).toHaveLength(2);
    expect(client.sendMessageCalls[1]!.text).toBe(
      "⚠️ Reply failed to send. Please try again.",
    );

    await channel.disconnect();
  });

  it("logs MarkdownV2 rejection with chatId when fallback triggers", async () => {
    const client = new MockFallbackClient([
      () => {
        throw new Error("400 Bad Request: can't parse entities");
      },
    ]);

    const { logger, entries } = createMockLogger();
    const channel = makeChannel(client, logger);
    await channel.connect();
    await channel.send(makeMarkdownV2Outbound(99));

    const warnEntry = entries.find(
      (entry) =>
        entry.level === "warn" &&
        entry.message === "telegram send: MarkdownV2 rejected, retrying as plain text",
    );

    expect(warnEntry).toBeDefined();
    expect(warnEntry!.data?.chatId).toBe(99);
    expect(warnEntry!.data?.error).toContain("400");

    await channel.disconnect();
  });
});

// ---------------------------------------------------------------------------
// Tests — Task 3.2: Error message fallback on total failure
// ---------------------------------------------------------------------------

describe("TelegramChannel error message fallback on total failure", () => {
  it("sends error message when MarkdownV2 and plain text both fail", async () => {
    const client = new MockFallbackClient([
      // Tier 1: MarkdownV2 → 400
      () => {
        throw new Error("400 Bad Request: can't parse entities");
      },
      // Tier 2: plain text retry → also fails (use permanent error to avoid sendWithRetry retries)
      () => {
        throw new Error("403 Forbidden: bot was blocked");
      },
      // Tier 3: error message fallback → succeeds (no handler = success)
    ]);

    const channel = makeChannel(client);
    await channel.connect();

    // Should NOT throw — error is absorbed after fallback
    await channel.send(makeMarkdownV2Outbound());

    expect(client.sendMessageCalls).toHaveLength(3);

    // Third call is the error message
    expect(client.sendMessageCalls[2]!.text).toBe(
      "⚠️ Reply failed to send. Please try again.",
    );
    expect(client.sendMessageCalls[2]!.options).toBeUndefined();

    await channel.disconnect();
  });

  it("does not throw when error message fallback itself fails", async () => {
    const client = new MockFallbackClient([
      // Tier 1: MarkdownV2 → 400
      () => {
        throw new Error("400 Bad Request: can't parse entities");
      },
      // Tier 2: plain text retry → fails (permanent error to avoid sendWithRetry retries)
      () => {
        throw new Error("403 Forbidden: bot was blocked");
      },
      // Tier 3: error message → also fails (permanent error)
      () => {
        throw new Error("401 Unauthorized");
      },
    ]);

    const { logger, entries } = createMockLogger();
    const channel = makeChannel(client, logger);
    await channel.connect();

    // Should still NOT throw — all errors absorbed
    await channel.send(makeMarkdownV2Outbound());

    expect(client.sendMessageCalls).toHaveLength(3);

    // Verify the error message fallback failure was logged
    const fallbackFailEntry = entries.find(
      (entry) =>
        entry.level === "warn" &&
        entry.message === "telegram send: error message fallback failed",
    );

    expect(fallbackFailEntry).toBeDefined();
    expect(fallbackFailEntry!.data?.error).toBe("401 Unauthorized");

    await channel.disconnect();
  });

  it("logs plain text fallback failure when both MarkdownV2 and plain text fail", async () => {
    const client = new MockFallbackClient([
      // Tier 1: MarkdownV2 → 400
      () => {
        throw new Error("400 Bad Request: can't parse entities");
      },
      // Tier 2: plain text retry → fails (permanent error to avoid sendWithRetry retries)
      () => {
        throw new Error("403 Forbidden: bot was blocked");
      },
      // Tier 3: error message → succeeds
    ]);

    const { logger, entries } = createMockLogger();
    const channel = makeChannel(client, logger);
    await channel.connect();
    await channel.send(makeMarkdownV2Outbound(77));

    const plainTextFailEntry = entries.find(
      (entry) =>
        entry.level === "warn" &&
        entry.message === "telegram send: plain text fallback failed",
    );

    expect(plainTextFailEntry).toBeDefined();
    expect(plainTextFailEntry!.data?.chatId).toBe(77);
    expect(plainTextFailEntry!.data?.error).toContain("403 Forbidden");

    await channel.disconnect();
  });
});
